// A run the host never answers must end in a kept failure Retry can act on, and never outlive its client.
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient,
  type SentRequest
} from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import type {
  DictationCapture,
  DictationCaptureChunk,
  DictationCaptureOpen
} from '../platform/audio-capture/dictation-capture-contract'

type Seam = {
  chunkHandlers: Set<(chunk: DictationCaptureChunk) => void>
  tail: Uint8Array | null
  // When set, capture.open parks until its settler runs: a start stuck in the unbounded starting window.
  holdOpen: boolean
  openSettlers: Array<(open: DictationCaptureOpen) => void>
  releaseCalls: number
  // The one capture both microphone owners share; set once the capture mock module loads.
  capture: DictationCapture | null
}

const seam = vi.hoisted((): Seam => ({
  chunkHandlers: new Set(),
  tail: null,
  holdOpen: false,
  openSettlers: [],
  releaseCalls: 0,
  capture: null
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))

// The voice-mode mic seam reaches the shared capture through the native device module.
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () => Promise.resolve({ granted: true }),
  speechFeed: () => {},
  tearDown: () => {},
  toggleRecording: () => true
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve()
}))

// Keep capture identity stable like both real seams; a fresh object on render would rerun teardown and cancel dictation.
vi.mock('../platform/audio-capture/dictation-capture', () => {
  const capture: DictationCapture = {
    open: async () => {
      if (seam.holdOpen) {
        return new Promise<DictationCaptureOpen>((resolve) => {
          seam.openSettlers.push(resolve)
        })
      }
      return { ok: true }
    },
    begin: () => true,
    end: async () => {
      // Page capture reads once more here and may deliver audio.
      const tail = seam.tail
      seam.tail = null
      if (tail !== null) {
        for (const handler of seam.chunkHandlers) {
          handler({ data: tail, droppedBytes: 0 })
        }
      }
    },
    release: () => {
      seam.releaseCalls += 1
    },
    onChunk: (handler) => {
      seam.chunkHandlers.add(handler)
      return {
        remove: () => {
          seam.chunkHandlers.delete(handler)
        }
      }
    },
    onInterruption: () => ({ remove: () => {} })
  }
  // Publish the shared capture so a test can hand it to the voice-mode seam like a live second owner.
  seam.capture = capture
  return { useDictationCapture: () => capture }
})

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'
import { createVoiceModeMicSeam } from '../voice-mode/voice-mode-mic-seam'
import {
  MOBILE_DICTATION_CLIENT_REPLACED_ERROR_MESSAGE,
  MOBILE_DICTATION_STALLED_ERROR_MESSAGE,
  MOBILE_DICTATION_START_STALL_MS,
  mobileDictationProcessingDeadlineMs
} from './mobile-dictation-phase-watchdog'

type Reply = (request: SentRequest) => 'hold' | { text?: string } | Error

// Answer every request; one reply can unblock the next.
async function pump(rpc: FakeRpcClient, sent: SentRequest[], reply: Reply): Promise<void> {
  for (let round = 0; round < 30; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      sent.push(request)
      const answer = reply(request)
      if (answer === 'hold') {
        continue
      }
      if (answer instanceof Error) {
        request.reject(answer)
      } else {
        request.resolve({ id: 'desktop', ok: true, result: answer })
      }
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

function paramsOf(request: SentRequest): Record<string, unknown> {
  const params = request.args[1]
  return typeof params === 'object' && params !== null ? { ...params } : {}
}

function deliver(bytes: number[]): void {
  for (const handler of seam.chunkHandlers) {
    handler({ data: Uint8Array.from(bytes), droppedBytes: 0 })
  }
}

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function dictation(): UseMobileDictationResult {
  const current = held.dictation
  if (current === null) {
    throw new Error('nothing mounted')
  }
  return current
}

// The shared capture a second microphone owner (voice mode) takes over mid-test.
function sharedCapture(): DictationCapture {
  const capture = seam.capture
  if (capture === null) {
    throw new Error('capture seam not loaded')
  }
  return capture
}

type ProbeProps = {
  client: FakeRpcClient
  inserted: string[]
  errors: { message: string; kept: boolean }[]
}

function Probe({ client, inserted, errors }: ProbeProps): null {
  held.dictation = useMobileDictation({
    client,
    enabled: true,
    onTranscript: (text) => inserted.push(text),
    onError: (error, outcome) => errors.push({ message: error.message, kept: outcome.kept })
  })
  return null
}

function mount(props: ProbeProps): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(Probe, props))
  })
  return (
    renderer ??
    ((): never => {
      throw new Error('nothing mounted')
    })()
  )
}

async function reachRecording(rpc: FakeRpcClient, sent: SentRequest[]): Promise<void> {
  await act(async () => {
    const started = dictation().start()
    await pump(rpc, sent, () => ({}))
    await started
  })
  expect(dictation().status).toBe('recording')
}

beforeEach(() => {
  vi.useFakeTimers()
  seam.chunkHandlers.clear()
  seam.tail = null
  seam.holdOpen = false
  seam.openSettlers.length = 0
  seam.releaseCalls = 0
  held.dictation = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a processing dictation whose transcript never arrives', () => {
  it('fails kept at the deadline, cancels on the host, and Retry plays the recording again', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const inserted: string[] = []
    const errors: { message: string; kept: boolean }[] = []
    const renderer = mount({ client: rpc, inserted, errors })
    await reachRecording(rpc, sent)
    await act(async () => {
      deliver([1, 2, 3, 4])
      await pump(rpc, sent, () => ({}))
    })
    seam.tail = Uint8Array.from([5, 6])
    await act(async () => {
      // The host never answers the finish; the dictation waits in processing (stop never settles).
      void dictation().stop()
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.finish' ? 'hold' : {}
      )
    })
    expect(dictation().status).toBe('processing')

    const heldFinish = sent.find((request) => request.method === 'speech.dictation.finish')
    expect(heldFinish).toBeDefined()
    const deadline = mobileDictationProcessingDeadlineMs(4 / 32_000)
    sent.length = 0
    await act(async () => {
      vi.advanceTimersByTime(deadline + 1)
      await pump(rpc, sent, () => ({}))
    })
    expect(dictation().status).toBe('error')
    expect(dictation().failure).toEqual({
      message: MOBILE_DICTATION_STALLED_ERROR_MESSAGE,
      offline: false
    })
    expect(errors).toEqual([{ message: MOBILE_DICTATION_STALLED_ERROR_MESSAGE, kept: true }])
    // The stalled run is cancelled on the host, so it cannot refuse the next start.
    expect(sent.some((request) => request.method === 'speech.dictation.cancel')).toBe(true)

    sent.length = 0
    await act(async () => {
      const retried = dictation().retry()
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.finish' ? { text: 'all of it' } : {}
      )
      await retried
    })
    expect(sent.map((request) => request.method)).toEqual([
      'speech.dictation.start',
      'speech.dictation.chunk',
      'speech.dictation.finish'
    ])
    // The whole recording, from the first byte, as seq 0 of the new dictation.
    expect(paramsOf(sent[1])).toMatchObject({ audioBase64: 'AQIDBAUG', seq: 0 })
    expect(inserted).toEqual(['all of it'])
    expect(dictation().failure).toBeNull()
    expect(dictation().status).toBe('idle')
    renderer.unmount()
  })
})

describe('a run whose host client is replaced mid-recording', () => {
  it('fails kept at once, and Retry replays the recording to the new client', async () => {
    const first = createFakeRpcClient()
    const sent: SentRequest[] = []
    const inserted: string[] = []
    const errors: { message: string; kept: boolean }[] = []
    const renderer = mount({ client: first, inserted, errors })
    await reachRecording(first, sent)
    await act(async () => {
      deliver([1, 2, 3, 4])
      await pump(first, sent, () => ({}))
    })

    // The scope hands the hook a replacement client: the new host never heard this dictation.
    const replacement = createFakeRpcClient()
    act(() => {
      renderer.update(createElement(Probe, { client: replacement, inserted, errors }))
    })
    await act(async () => {
      await pump(first, sent, () => ({}))
    })
    expect(dictation().status).toBe('error')
    expect(dictation().failure).toEqual({
      message: MOBILE_DICTATION_CLIENT_REPLACED_ERROR_MESSAGE,
      offline: false
    })
    expect(errors).toEqual([
      { message: MOBILE_DICTATION_CLIENT_REPLACED_ERROR_MESSAGE, kept: true }
    ])

    sent.length = 0
    await act(async () => {
      const retried = dictation().retry()
      await pump(replacement, sent, (request) =>
        request.method === 'speech.dictation.finish' ? { text: 'all of it' } : {}
      )
      await retried
    })
    expect(sent.map((request) => request.method)).toEqual([
      'speech.dictation.start',
      'speech.dictation.chunk',
      'speech.dictation.finish'
    ])
    expect(inserted).toEqual(['all of it'])
    expect(dictation().failure).toBeNull()
    renderer.unmount()
  })

  it('keeps recording through a reconnect on the same client', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const renderer = mount({ client: rpc, inserted: [], errors: [] })
    await reachRecording(rpc, sent)
    await act(async () => {
      deliver([1, 2, 3, 4])
      await pump(rpc, sent, () => ({}))
    })
    act(() => {
      rpc.pushState('disconnected')
      rpc.pushState('connected')
    })
    // A reconnect must not end a recording: the host keeps the session through it.
    expect(dictation().status).toBe('recording')
    expect(dictation().failure).toBeNull()
    renderer.unmount()
  })
})

describe('a client replaced while the microphone open is still pending', () => {
  it('abandons the fenced start, and the late open releases the idle session', async () => {
    const first = createFakeRpcClient()
    const sent: SentRequest[] = []
    const errors: { message: string; kept: boolean }[] = []
    const renderer = mount({ client: first, inserted: [], errors })
    seam.holdOpen = true
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await Promise.resolve()
    })
    expect(dictation().status).toBe('starting')
    // Nothing is on the wire: the start is fenced to a client about to be replaced.
    expect(sent).toEqual([])

    // The scope hands the hook a replacement client while the open is still pending.
    const replacement = createFakeRpcClient()
    act(() => {
      renderer.update(createElement(Probe, { client: replacement, inserted: [], errors }))
    })
    // The start was fenced to the replaced client: it is abandoned instead of splitting across hosts.
    expect(dictation().status).toBe('idle')

    // The late open settles; nobody owns the session, so it releases, and nothing records.
    // Earlier tests' unmount flushes lazily into this one, so count the release as a delta.
    const releasesBefore = seam.releaseCalls
    await act(async () => {
      seam.openSettlers.shift()?.({ ok: true })
      await pump(first, sent, () => ({}))
    })
    expect(dictation().status).toBe('idle')
    expect(seam.releaseCalls - releasesBefore).toBe(1)
    expect(sent).toEqual([])

    // A press now starts fresh on the replacement client.
    seam.holdOpen = false
    await act(async () => {
      const started = dictation().start()
      await pump(replacement, sent, () => ({}))
      await started
    })
    expect(dictation().status).toBe('recording')
    renderer.unmount()
  })
})

describe('a stale open that settles while a Retry is replaying', () => {
  it('releases the session Retry does not own, without ending the retry', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const renderer = mount({ client: rpc, inserted: [], errors: [] })
    seam.holdOpen = true
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await Promise.resolve()
    })
    expect(dictation().status).toBe('starting')
    // The start stalls past its bound; a new press supersedes it and records.
    act(() => {
      vi.advanceTimersByTime(MOBILE_DICTATION_START_STALL_MS + 1)
    })
    expect(dictation().startStalled).toBe(true)
    seam.holdOpen = false
    await act(async () => {
      const restarted = dictation().start()
      await pump(rpc, sent, () => ({}))
      await restarted
    })
    expect(dictation().status).toBe('recording')
    await act(async () => {
      deliver([1, 2, 3, 4])
      await pump(rpc, sent, () => ({}))
    })
    // The replacement's finish never lands, so it fails kept at its processing deadline.
    await act(async () => {
      void dictation().stop()
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.finish' ? 'hold' : {}
      )
      vi.advanceTimersByTime(mobileDictationProcessingDeadlineMs(0) + 1)
      await pump(rpc, sent, () => ({}))
    })
    expect(dictation().failure).not.toBeNull()

    // Retry replays while the first open is still parked; its late settle releases the session
    // Retry does not own, and leaves the replay alone.
    const releasesBefore = seam.releaseCalls
    await act(async () => {
      const retried = dictation().retry()
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.finish' ? 'hold' : {}
      )
      seam.openSettlers.shift()?.({ ok: true })
      await pump(rpc, sent, () => ({}))
      await retried
    })
    expect(dictation().status).toBe('processing')
    expect(seam.releaseCalls - releasesBefore).toBe(1)
    renderer.unmount()
  })
})

describe('a microphone open pending at unmount', () => {
  it('releases the audio session when it settles after the unmount', async () => {
    const rpc = createFakeRpcClient()
    const renderer = mount({ client: rpc, inserted: [], errors: [] })
    seam.holdOpen = true
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await Promise.resolve()
    })
    expect(dictation().status).toBe('starting')
    const releasesBefore = seam.releaseCalls
    renderer.unmount()
    // Flush the unmount's passive destroy before settling, like the real teardown order.
    await act(async () => {})

    // The open settles with the hook gone: nothing owns the session, so the late open releases it.
    await act(async () => {
      seam.openSettlers.shift()?.({ ok: true })
      await Promise.resolve()
    })
    // The unmount's own release and the stale open's release.
    expect(seam.releaseCalls - releasesBefore).toBe(2)
  })
})

describe('a retry replaying a long recording', () => {
  it('outlasts the short-audio deadline and fails kept at the full-recording deadline', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const inserted: string[] = []
    const errors: { message: string; kept: boolean }[] = []
    const renderer = mount({ client: rpc, inserted, errors })
    await reachRecording(rpc, sent)
    await act(async () => {
      // 150 one-second chunks: past the 60-second finish floor, so the deadline tracks the audio.
      for (let second = 0; second < 150; second += 1) {
        deliver(Array.from({ length: 32_000 }, (_unused, byte) => byte % 256))
        await pump(rpc, sent, () => ({}))
      }
    })
    seam.tail = Uint8Array.from([5, 6])
    await act(async () => {
      void dictation().stop()
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.finish' ? 'hold' : {}
      )
    })
    expect(dictation().status).toBe('processing')
    const shortDeadline = mobileDictationProcessingDeadlineMs(0)
    const fullDeadline = mobileDictationProcessingDeadlineMs(150)
    expect(fullDeadline).toBeGreaterThan(shortDeadline)
    // The run the host never finished is kept at its own (full-recording) deadline.
    await act(async () => {
      vi.advanceTimersByTime(fullDeadline + 1)
      await pump(rpc, sent, () => ({}))
    })
    expect(dictation().status).toBe('error')
    expect(dictation().failure).toEqual({
      message: MOBILE_DICTATION_STALLED_ERROR_MESSAGE,
      offline: false
    })

    // Retry enters processing before its kept recording is sent, so the sent count it would
    // otherwise be bounded by is zero: the bound must still cover the whole recording.
    sent.length = 0
    await act(async () => {
      const retried = dictation().retry()
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.finish' ? 'hold' : {}
      )
      await retried
    })
    expect(dictation().status).toBe('processing')
    expect(sent.some((request) => request.method === 'speech.dictation.start')).toBe(true)

    await act(async () => {
      vi.advanceTimersByTime(shortDeadline + 1)
      await pump(rpc, sent, () => ({}))
    })
    // Past the short-audio deadline with the long replay still going: not a stall.
    expect(dictation().status).toBe('processing')

    await act(async () => {
      vi.advanceTimersByTime(fullDeadline - shortDeadline + 1)
      await pump(rpc, sent, () => ({}))
    })
    expect(dictation().status).toBe('error')
    expect(dictation().failure).toEqual({
      message: MOBILE_DICTATION_STALLED_ERROR_MESSAGE,
      offline: false
    })
    renderer.unmount()
  })
})

describe('a stale open that settles while voice mode holds the microphone', () => {
  it('leaves the session the voice loop owns alone', async () => {
    const first = createFakeRpcClient()
    const sent: SentRequest[] = []
    const errors: { message: string; kept: boolean }[] = []
    const renderer = mount({ client: first, inserted: [], errors })
    seam.holdOpen = true
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await Promise.resolve()
    })
    expect(dictation().status).toBe('starting')

    // The scope hands the hook a replacement client while the open is still pending, so the start
    // is abandoned to idle exactly like the case above — but voice mode takes the shared microphone
    // before the stale open settles.
    const replacement = createFakeRpcClient()
    act(() => {
      renderer.update(createElement(Probe, { client: replacement, inserted: [], errors }))
    })
    expect(dictation().status).toBe('idle')

    const voiceMic = createVoiceModeMicSeam({ current: sharedCapture() })
    const releasesBefore = seam.releaseCalls
    seam.holdOpen = false
    await act(async () => {
      expect(await voiceMic.openMic()).toBe(true)
    })

    // The abandoned open settles at last. Dictation is idle and owns nothing, so only the voice
    // loop's live claim stands between this settle and tearing the shared microphone down — the
    // claimless variant above releases here, this one must not.
    await act(async () => {
      seam.openSettlers.shift()?.({ ok: true })
      await pump(first, sent, () => ({}))
    })
    expect(dictation().status).toBe('idle')
    expect(seam.releaseCalls - releasesBefore).toBe(0)
    expect(sent).toEqual([])

    voiceMic.closeMic()
    renderer.unmount()
  })
})

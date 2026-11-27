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
  DictationCaptureChunk
} from '../platform/audio-capture/dictation-capture-contract'

type Seam = {
  chunkHandlers: Set<(chunk: DictationCaptureChunk) => void>
  tail: Uint8Array | null
}

const seam = vi.hoisted((): Seam => ({ chunkHandlers: new Set(), tail: null }))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))

// Keep capture identity stable like both real seams; a fresh object on render would rerun teardown and cancel dictation.
vi.mock('../platform/audio-capture/dictation-capture', () => {
  const capture: DictationCapture = {
    open: async () => ({ ok: true }),
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
    release: () => {},
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
  return { useDictationCapture: () => capture }
})

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'
import {
  MOBILE_DICTATION_CLIENT_REPLACED_ERROR_MESSAGE,
  MOBILE_DICTATION_STALLED_ERROR_MESSAGE,
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

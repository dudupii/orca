// A start that never gets going must give way to a new press, and its late microphone work must not cut the replacement.
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient,
  type SentRequest
} from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import type { DictationCaptureChunk } from '../platform/audio-capture/dictation-capture-contract'

type PermissionSettler = { grant: () => void; refuse: (error: unknown) => void }

type DeviceLog = {
  calls: string[]
  permissions: PermissionSettler[]
  chunkHandlers: Set<(chunk: DictationCaptureChunk) => void>
}

const device = vi.hoisted((): DeviceLog => ({
  calls: [],
  permissions: [],
  chunkHandlers: new Set()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'android' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: (name: string, listener: (event: { data: unknown }) => void) => {
    if (name === 'onMicrophoneData') {
      const cast = listener as (event: { data: Uint8Array }) => void
      device.chunkHandlers.add((chunk) => cast({ data: chunk.data }))
    }
    return { remove: () => {} }
  },
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () =>
    new Promise((resolve, reject) => {
      device.permissions.push({
        grant: () => resolve({ granted: true }),
        refuse: (error) => reject(error)
      })
    }),
  tearDown: () => device.calls.push('tearDown'),
  toggleRecording: (on: boolean) => {
    device.calls.push(`toggleRecording(${String(on)})`)
    return true
  }
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve()
}))

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'
import { MOBILE_DICTATION_START_STALL_MS } from './mobile-dictation-phase-watchdog'

type Reply = (request: SentRequest) => 'hold' | {} | Error

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

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function dictation(): UseMobileDictationResult {
  const current = held.dictation
  if (current === null) {
    throw new Error('nothing mounted')
  }
  return current
}

function mount(rpc: FakeRpcClient): ReactTestRenderer {
  function Probe(): null {
    held.dictation = useMobileDictation({
      client: rpc,
      enabled: true,
      onTranscript: () => {},
      onError: () => {}
    })
    return null
  }
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(Probe))
  })
  return (
    renderer ??
    ((): never => {
      throw new Error('nothing mounted')
    })()
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  device.calls.length = 0
  device.permissions.length = 0
  device.chunkHandlers.clear()
  held.dictation = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a microphone open that never answers', () => {
  it('is superseded by a new press, whose recording the late open must not release', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const renderer = mount(rpc)
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      await Promise.resolve()
    })
    // The permission prompt never settles: the start is stuck in starting, with nothing on the wire.
    expect(dictation().status).toBe('starting')
    expect(sent).toEqual([])

    act(() => {
      vi.advanceTimersByTime(MOBILE_DICTATION_START_STALL_MS + 1)
    })
    expect(dictation().startStalled).toBe(true)

    await act(async () => {
      const restarted = dictation().start()
      // Grant the replacement's prompt; the stuck first one stays pending for now.
      device.permissions.at(-1)?.grant()
      await pump(rpc, sent, () => ({}))
      await restarted
    })
    expect(dictation().status).toBe('recording')

    // The stuck open settles at last; it must not release the replacement's microphone.
    await act(async () => {
      device.permissions.shift()?.grant()
      await pump(rpc, sent, () => ({}))
    })
    expect(dictation().status).toBe('recording')
    expect(device.calls).toEqual(['toggleRecording(true)'])
    renderer.unmount()
  })
})

describe('a host start that never answers', () => {
  it('is superseded by a new press, which cancels the stalled one and starts fresh', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const renderer = mount(rpc)
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      device.permissions.shift()?.grant()
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.start' ? 'hold' : {}
      )
    })
    expect(dictation().status).toBe('starting')

    act(() => {
      vi.advanceTimersByTime(MOBILE_DICTATION_START_STALL_MS + 1)
    })
    expect(dictation().startStalled).toBe(true)

    const stalledStart = sent.find((request) => request.method === 'speech.dictation.start')
    expect(stalledStart).toBeDefined()
    await act(async () => {
      const restarted = dictation().start()
      // Its request times out at last, like the real transport would have done long before.
      stalledStart?.reject(new Error('Request timed out: speech.dictation.start'))
      // The stalled run cancels first; only once that settles does the replacement open the microphone.
      await pump(rpc, sent, () => ({}))
      device.permissions.shift()?.grant()
      await pump(rpc, sent, () => ({}))
      await restarted
    })
    expect(dictation().status).toBe('recording')
    // The stalled dictation was cancelled on the host, and the replacement started under a new id.
    const ids = sent
      .filter((request) => request.method === 'speech.dictation.start')
      .map((request) => paramsOf(request).dictationId)
    const cancels = sent
      .filter((request) => request.method === 'speech.dictation.cancel')
      .map((request) => paramsOf(request).dictationId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(cancels).toContain(ids[0])
    renderer.unmount()
  })
})

describe('a live start that has not stalled', () => {
  it('keeps the mic: a press during it is ignored, not a supersede', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const renderer = mount(rpc)
    await act(async () => {
      void dictation()
        .start()
        .catch(() => undefined)
      device.permissions.shift()?.grant()
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.start' ? 'hold' : {}
      )
    })
    expect(dictation().status).toBe('starting')
    expect(dictation().startStalled).toBe(false)

    await act(async () => {
      const pressed = dictation().start()
      await Promise.resolve()
      await pressed
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.start' ? 'hold' : {}
      )
    })
    // Still the one start, still beginning; the press did not restart it.
    const starts = sent.filter((request) => request.method === 'speech.dictation.start')
    expect(starts).toHaveLength(1)
    expect(device.permissions).toEqual([])
    expect(dictation().status).toBe('starting')
    renderer.unmount()
  })
})

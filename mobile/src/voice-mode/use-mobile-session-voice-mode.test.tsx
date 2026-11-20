// The session hook's side of the loop: who owns the recognizer, how a failed entry unwinds, and that no reply poll outlives its shell.
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DictationCapture,
  DictationCaptureOpen
} from '../platform/audio-capture/dictation-capture-contract'
import type { OnDeviceSpeech } from '../platform/speech/on-device-speech-contract'
import type {
  BridgeSpeechRead,
  BridgeSpeechStartResult
} from '../mobile-web-shell/bridge/native-capabilities/bridge-speech-verbs'
import type { MobileDictationHost } from '../dictation/mobile-dictation-host-context'
import { MobileDictationHostContext } from '../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { createMobileDictationMeter } from '../hooks/mobile-dictation-meter'

type Seam = {
  calls: string[]
  read: BridgeSpeechRead
  speechStartResult: BridgeSpeechStartResult | Error
  openResult: DictationCaptureOpen | Error
  beginResult: boolean | Error
  turnActive: boolean
}

const seam = vi.hoisted((): Seam => ({
  calls: [],
  read: { revision: 0, committed: '', tentative: '', failure: null },
  speechStartResult: { started: true, locale: 'en-US', reason: null },
  openResult: { ok: true },
  beginResult: true,
  turnActive: false
}))

// The capture and speech contracts let the bridge reject and native begin throw part-way.
function settle<T>(value: T | Error): Promise<T> {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
}

function settleBegin(): boolean {
  if (seam.beginResult instanceof Error) {
    throw seam.beginResult
  }
  return seam.beginResult
}

vi.mock('../platform/speech/on-device-speech', () => {
  const speech: OnDeviceSpeech = {
    status: async () => ({ status: 'ready', locale: 'en-US', preference: 'automatic' }),
    start: async () => {
      seam.calls.push('speech.start')
      return settle(seam.speechStartResult)
    },
    read: async () => seam.read,
    finish: async () => ({ text: null, failure: null }),
    cancel: () => {
      seam.calls.push('speech.cancel')
    }
  }
  return { useOnDeviceSpeech: () => speech }
})

vi.mock('../platform/audio-capture/dictation-capture', () => {
  const capture: DictationCapture = {
    open: async () => {
      seam.calls.push('capture.open')
      return settle(seam.openResult)
    },
    begin: () => {
      seam.calls.push('capture.begin')
      return settleBegin()
    },
    end: async () => {
      seam.calls.push('capture.end')
    },
    release: () => {
      seam.calls.push('capture.release')
    },
    onChunk: () => ({ remove: () => {} }),
    onInterruption: () => ({ remove: () => {} })
  }
  return { useDictationCapture: () => capture }
})

vi.mock('../platform/audio-capture/native-audio-device', () => ({
  nativeMicrophoneScreenLock: {
    hold: () => {
      seam.calls.push('screen.hold')
    },
    release: () => {
      seam.calls.push('screen.release')
    }
  }
}))

vi.mock('../storage/voice-mode-settings', () => ({
  VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS: 1.5,
  loadVoiceModeResponseDelaySeconds: vi.fn(async () => 1.5),
  saveVoiceModeResponseDelaySeconds: vi.fn(async () => {})
}))

import { useMobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import type { MobileSessionVoiceMode } from './use-mobile-session-voice-mode'

function fakeDictation(recording: boolean): UseMobileDictationResult {
  return {
    status: recording ? 'recording' : 'idle',
    isStarting: false,
    isRecording: recording,
    isProcessing: false,
    transcriptSoFar: '',
    error: null,
    failure: null,
    engine: null,
    start: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    meter: createMobileDictationMeter()
  }
}

type Harness = {
  voiceMode: () => MobileSessionVoiceMode
  showToast: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setDictationBusy: (busy: boolean) => void
  unmount: () => void
}

function mountVoiceMode(): Harness {
  const showToast = vi.fn()
  const send = vi.fn(async () => true)
  let dictation = fakeDictation(false)
  const host: MobileDictationHost = {
    owner: null,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    announce: vi.fn(),
    attach: vi.fn(() => () => {}),
    refresh: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getDictation: () => dictation,
    getIdleDictation: () => dictation,
    getUnderway: () => dictation.isStarting || dictation.isRecording || dictation.isProcessing
  }
  let voiceMode: MobileSessionVoiceMode | null = null
  function Probe(): null {
    voiceMode = useMobileSessionVoiceMode(showToast, {
      handleNativeChatSend: send,
      nativeChatTurnActive: seam.turnActive,
      showNativeChat: true
    })
    return null
  }
  let renderer: ReactTestRenderer
  act(() => {
    renderer = create(
      createElement(MobileDictationHostContext.Provider, { value: host }, createElement(Probe))
    )
  })
  return {
    voiceMode: () => {
      if (voiceMode === null) {
        throw new Error('nothing mounted')
      }
      return voiceMode
    },
    showToast,
    send,
    setDictationBusy: (busy) => {
      dictation = fakeDictation(busy)
    },
    unmount: () => act(() => renderer.unmount())
  }
}

// The entry's startup rides only microtasks; drain them so the shell settles and its dropper effect runs inside the act.
async function flushEntry(): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    await Promise.resolve()
  }
}

// Speaks one committed utterance through the hook's default timings: read at 150ms, silence window 1200ms, delay 1500ms.
async function speakAndCommit(harness: Harness): Promise<void> {
  await act(async () => {
    harness.voiceMode().start()
    await flushEntry()
  })
  seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150 + 1200 + 1500)
  })
}

describe('useMobileSessionVoiceMode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    seam.calls.length = 0
    seam.read = { revision: 0, committed: '', tentative: '', failure: null }
    seam.speechStartResult = { started: true, locale: 'en-US', reason: null }
    seam.openResult = { ok: true }
    seam.beginResult = true
    seam.turnActive = false
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('refuses without touching the recognizer while the page dictation holds it, then starts once it is free', async () => {
    const harness = mountVoiceMode()
    harness.setDictationBusy(true)
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    expect(harness.showToast).toHaveBeenCalledOnce()
    expect(seam.calls).not.toContain('speech.start')
    expect(seam.calls).not.toContain('capture.open')

    // The refusal was non-destructive and the failed shell dropped: the next entry starts for real.
    harness.setDictationBusy(false)
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    expect(seam.calls).toContain('speech.start')
    expect(seam.calls).toContain('capture.open')
    expect(harness.voiceMode().view.route).toBe('listening')
  })

  it('reports a recognizer start that rejects and retries on the next entry', async () => {
    seam.speechStartResult = new Error('bridge refused')
    const harness = mountVoiceMode()
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    expect(harness.showToast).toHaveBeenCalledOnce()
    expect(seam.calls).not.toContain('capture.open')
    expect(harness.voiceMode().view.route).toBe('closed')

    seam.speechStartResult = { started: true, locale: 'en-US', reason: null }
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    expect(harness.voiceMode().view.route).toBe('listening')
  })

  it('reports a microphone open that rejects, unwinds what it held, and retries on the next entry', async () => {
    seam.openResult = new Error('bridge refused')
    const harness = mountVoiceMode()
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    expect(harness.showToast).toHaveBeenCalledOnce()
    expect(seam.calls).toContain('screen.hold')
    expect(seam.calls).toContain('screen.release')
    expect(seam.calls).toContain('speech.cancel')
    expect(harness.voiceMode().view.route).toBe('closed')

    seam.openResult = { ok: true }
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    expect(harness.voiceMode().view.route).toBe('listening')
  })

  it('ends an opened microphone whose begin throws and reports it unavailable', async () => {
    seam.beginResult = new Error('native threw part-way')
    const harness = mountVoiceMode()
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    expect(harness.showToast).toHaveBeenCalledOnce()
    expect(seam.calls).toContain('capture.end')
    expect(harness.voiceMode().view.route).toBe('closed')
  })

  it('exit stops the reply poll with the loop, leaving nothing scheduled', async () => {
    seam.turnActive = true
    const harness = mountVoiceMode()
    await speakAndCommit(harness)
    expect(harness.send).toHaveBeenCalledWith('hello')
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    act(() => {
      harness.voiceMode().exit()
    })
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(harness.send).toHaveBeenCalledOnce()
  })

  it('unmounting with a reply poll live clears it and resolves the waiting send', async () => {
    seam.turnActive = true
    const harness = mountVoiceMode()
    await speakAndCommit(harness)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    harness.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
  })
})

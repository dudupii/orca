// The binder's side of the loop: who owns the recognizer, how a failed entry unwinds, that no
// reply poll outlives the page, and the readout's outcomes — all through the page's host.
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DictationCapture,
  DictationCaptureOpen
} from '../platform/audio-capture/dictation-capture-contract'
import type { OnDeviceSpeech } from '../platform/speech/on-device-speech-contract'
import type { OnDeviceTtsChannelStatus } from '../platform/tts/on-device-tts-contract'
import type {
  BridgeSpeechRead,
  BridgeSpeechStartResult
} from '../mobile-web-shell/bridge/native-capabilities/bridge-speech-verbs'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { MobileVoiceModeOwnerChat } from './voice-mode-host-context'
import { MobileDictationHostContext } from '../dictation/mobile-dictation-host-context'
import type { MobileDictationHost } from '../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { createMobileDictationMeter } from '../hooks/mobile-dictation-meter'
import type { MobileSessionController } from '../session/use-mobile-session-controller'

type SpeakBroadcast = { text: string; lang: string | null; session: string | null }

type Seam = {
  calls: string[]
  read: BridgeSpeechRead
  speechStartResult: BridgeSpeechStartResult | Error
  openResult: DictationCaptureOpen | Error
  beginResult: boolean | Error
  turnActive: boolean
  replyText: string
  ttsAvailable: boolean
  ttsStatus: OnDeviceTtsChannelStatus
  ttsSpeakCalls: { text: string; locale: string | null }[]
  ttsStopCalls: number
  sendOutcome: MobileNativeChatSendOutcome
  speakSink: ((broadcast: SpeakBroadcast) => void) | null
}

const seam = vi.hoisted((): Seam => ({
  calls: [],
  read: { revision: 0, committed: '', tentative: '', failure: null },
  speechStartResult: { started: true, locale: 'en-US', reason: null },
  openResult: { ok: true },
  beginResult: true,
  turnActive: false,
  replyText: '',
  ttsAvailable: true,
  ttsStatus: 'done',
  ttsSpeakCalls: [],
  ttsStopCalls: 0,
  sendOutcome: 'accepted',
  speakSink: null
}))

// The chat the mic press captures; its identity is all the host needs from the controller here.
const OWNER_CHAT: MobileVoiceModeOwnerChat = {
  structured: false,
  agent: 'claude',
  sessionId: 'session-1',
  transcriptPath: null,
  agentConfirmed: true,
  sessionLive: true,
  handle: 'term-1',
  tabId: 'tab-1'
}

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

vi.mock('../platform/tts/on-device-tts', () => {
  // A channel whose utterances are already done by the first poll, so a playback settles within one read.
  let revision = 0
  const channel = {
    speak: (utterance: { text: string; locale: string | null }) => {
      seam.ttsSpeakCalls.push({ text: utterance.text, locale: utterance.locale })
      revision += 1
      return Promise.resolve({ revision })
    },
    stop: () => {
      seam.ttsStopCalls += 1
      // A stopped speaker reads back stopped, so a live playback poll settles instead of spinning.
      seam.ttsStatus = 'stopped'
      return Promise.resolve()
    },
    read: () => Promise.resolve({ revision, status: seam.ttsStatus, reason: null })
  }
  return { useOnDeviceTts: () => (seam.ttsAvailable ? channel : null) }
})

vi.mock('../storage/voice-mode-settings', () => ({
  VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS: 1.5,
  loadVoiceModeResponseDelaySeconds: vi.fn(async () => 1.5),
  saveVoiceModeResponseDelaySeconds: vi.fn(async () => {}),
  loadVoiceModeBargeIn: vi.fn(async () => true),
  saveVoiceModeBargeIn: vi.fn(async () => {}),
  loadVoiceModeFallbackReadout: vi.fn(async () => true),
  saveVoiceModeFallbackReadout: vi.fn(async () => {})
}))

vi.mock('expo-router', () => ({
  useFocusEffect: () => {},
  useRouter: () => ({ push: () => {} }),
  useNavigation: () => undefined
}))

// The host provider reads AppState for the loop's foreground policy; this file never drives it.
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))

vi.mock('./speak-broadcast', () => ({
  subscribeToSpeakBroadcasts: (
    _client: RpcClient,
    onBroadcast: (broadcast: SpeakBroadcast) => void
  ) => {
    seam.speakSink = onBroadcast
    return () => {
      seam.speakSink = null
    }
  }
}))

import { MobileVoiceModeHostProvider } from './voice-mode-host'
import { useMobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import type { MobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import { loadVoiceModeBargeIn, loadVoiceModeFallbackReadout } from '../storage/voice-mode-settings'
import type {
  MobileNativeChatSendIntent,
  MobileNativeChatSendOutcome
} from '../session/native-chat/composer/delivery/mobile-native-chat-send'

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
  sendWithOutcome: ReturnType<typeof vi.fn>
  setDictationBusy: (busy: boolean) => void
  setTurnActive: (active: boolean) => void
  broadcast: (broadcast: SpeakBroadcast) => void
  subscriptionLive: () => boolean
  unmount: () => void
}

function mountVoiceMode(): Harness {
  const showToast = vi.fn()
  const send = vi.fn(async () => true)
  // The chat's send verb both loop paths ride; the steer intent is the only thing telling them apart.
  const sendWithOutcome = vi.fn(
    async (
      _text: string,
      _images?: string[],
      _deadline?: number,
      _attachments?: readonly unknown[],
      _sentAt?: number,
      _intent?: MobileNativeChatSendIntent
    ): Promise<MobileNativeChatSendOutcome> => seam.sendOutcome
  )
  let dictation = fakeDictation(false)
  const dictationHost: MobileDictationHost = {
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
  // The binder reads a slice of the controller; its captured seam answers live the way the real
  // controller's refs do, so no rerender is needed to move the seam's truth.
  const controller = {
    hostId: 'host-1',
    worktreeId: 'wt-1',
    client: {} as RpcClient,
    showToast,
    worktreeResolution: 'present',
    sessionTabs: [],
    activeSessionTab: null,
    showNativeChat: true,
    nativeChatController: {
      handleNativeChatSend: send,
      handleNativeChatSendWithOutcome: sendWithOutcome,
      nativeChatVoiceSeam: {
        send,
        steer: (text: string) =>
          sendWithOutcome(text, undefined, undefined, undefined, undefined, { steer: true }).then(
            (outcome) => ({ steered: outcome !== 'rejected' })
          ),
        turnActive: () => seam.turnActive,
        latestReplyText: () => seam.replyText
      },
      nativeChatVoiceOwnerChat: () => OWNER_CHAT
    }
  } as unknown as MobileSessionController
  let voiceMode: MobileSessionVoiceMode | null = null
  function Probe(): null {
    voiceMode = useMobileSessionVoiceMode(controller)
    return null
  }
  let renderer: ReactTestRenderer
  act(() => {
    renderer = create(
      createElement(
        MobileDictationHostContext.Provider,
        { value: dictationHost },
        createElement(MobileVoiceModeHostProvider, null, createElement(Probe))
      )
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
    sendWithOutcome,
    setDictationBusy: (busy) => {
      dictation = fakeDictation(busy)
    },
    setTurnActive: (active) => {
      seam.turnActive = active
    },
    broadcast: (broadcast) => {
      act(() => {
        seam.speakSink?.(broadcast)
      })
    },
    subscriptionLive: () => seam.speakSink !== null,
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
    seam.replyText = ''
    seam.ttsAvailable = true
    seam.ttsStatus = 'done'
    seam.ttsSpeakCalls.length = 0
    seam.ttsStopCalls = 0
    seam.sendOutcome = 'accepted'
    seam.speakSink = null
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

  it('unmounting the page with a reply poll live clears it and resolves the waiting send', async () => {
    seam.turnActive = true
    const harness = mountVoiceMode()
    await speakAndCommit(harness)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    harness.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
  })

  it('speaks the reply text the chat holds when its turn settles and no briefing arrived', async () => {
    seam.turnActive = true
    seam.replyText = 'The build passed. Tests are green.'
    const harness = mountVoiceMode()
    await speakAndCommit(harness)

    harness.setTurnActive(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 150 + 100)
    })
    // No briefing arrived, so the reply's condensed prose is spoken in the phone's language.
    expect(seam.ttsSpeakCalls).toEqual([
      { text: 'The build passed. Tests are green.', locale: null }
    ])
    expect(harness.voiceMode().view.route).toBe('listening')
  })

  it('speaks a briefing broadcast that arrived while the reply streamed, over the reply prose', async () => {
    seam.turnActive = true
    seam.replyText = 'A very long reply. Not the readout. More words here.'
    const harness = mountVoiceMode()
    await speakAndCommit(harness)

    harness.broadcast({ text: 'Checks pass.', lang: 'zh-CN', session: null })
    harness.setTurnActive(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 150 + 100)
    })
    // The briefing wins over the reply prose and carries its own language.
    expect(seam.ttsSpeakCalls).toEqual([{ text: 'Checks pass.', locale: 'zh-CN' }])
    expect(harness.voiceMode().view.route).toBe('listening')
  })

  it('stays silent with no tts verb, yet the loop still returns to listening', async () => {
    seam.ttsAvailable = false
    seam.turnActive = true
    seam.replyText = 'Words that cannot play.'
    const harness = mountVoiceMode()
    await speakAndCommit(harness)

    harness.setTurnActive(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 100)
    })
    expect(seam.ttsSpeakCalls).toEqual([])
    expect(harness.voiceMode().view.route).toBe('listening')
  })

  it('drops the speak subscription with the loop, so broadcasts after an exit land nowhere', async () => {
    seam.turnActive = true
    const harness = mountVoiceMode()
    await speakAndCommit(harness)
    expect(harness.subscriptionLive()).toBe(true)

    act(() => {
      harness.voiceMode().exit()
    })
    expect(harness.subscriptionLive()).toBe(false)

    harness.broadcast({ text: 'Late words.', lang: null, session: null })
    expect(seam.ttsSpeakCalls).toEqual([])
  })

  it('stays silent for the fallback reply when it was saved off after the mount', async () => {
    seam.turnActive = true
    seam.replyText = 'A reply the setting now mutes.'
    const harness = mountVoiceMode()
    await act(async () => {
      await flushEntry()
    })
    // Each start reads the toggles anew, so a save made since the last loop is in force for this one.
    vi.mocked(loadVoiceModeFallbackReadout).mockResolvedValue(false)
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 1200 + 1500)
    })

    harness.setTurnActive(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 100)
    })
    // Fallback readout off: the unbriefed reply is never spoken, yet the loop still walks back to listening.
    expect(seam.ttsSpeakCalls).toEqual([])
    expect(harness.voiceMode().view.route).toBe('listening')
  })

  it('lets speech pass over the playback when barge-in was saved off after the mount load', async () => {
    seam.turnActive = true
    seam.replyText = 'Words that keep playing.'
    // A playback that never settles on its own holds the loop in speaking until something stops it.
    seam.ttsStatus = 'speaking'
    const harness = mountVoiceMode()
    await act(async () => {
      await flushEntry()
    })
    vi.mocked(loadVoiceModeBargeIn).mockResolvedValue(false)
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 1200 + 1500)
    })

    harness.setTurnActive(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 150 + 150)
    })
    expect(seam.ttsSpeakCalls).toEqual([{ text: 'Words that keep playing.', locale: null }])
    expect(harness.voiceMode().view.route).toBe('speaking')

    // Speech over the playback is dropped, not a barge-in: the speaker was never told to stop.
    seam.read = { revision: 2, committed: 'hello more words', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 150)
    })
    expect(seam.ttsStopCalls).toBe(0)
    expect(harness.voiceMode().view.route).toBe('speaking')

    act(() => {
      harness.voiceMode().exit()
    })
    // The exit silenced the speaker; its one live poll drains on the next tick and leaves nothing scheduled.
    expect(seam.ttsStopCalls).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 150)
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds an entry until the persisted toggles answer, so a start ahead of the storage read still honors them', async () => {
    seam.turnActive = true
    seam.replyText = 'A reply the late read mutes.'
    let releaseLoad: ((fallback: false) => void) | null = null
    const gated = new Promise<false>((resolve) => {
      releaseLoad = resolve
    })
    vi.mocked(loadVoiceModeFallbackReadout).mockReturnValue(gated)
    const harness = mountVoiceMode()
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    // The settings read has not answered: no loop exists yet, so no default can sneak in.
    expect(harness.voiceMode().view.route).toBe('idle')
    expect(seam.calls).not.toContain('speech.start')

    await act(async () => {
      releaseLoad?.(false)
      await flushEntry()
    })
    expect(harness.voiceMode().view.route).toBe('listening')
    seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 1200 + 1500)
    })

    harness.setTurnActive(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 100)
    })
    expect(seam.ttsSpeakCalls).toEqual([])
    expect(harness.voiceMode().view.route).toBe('listening')
  })

  it('hands mid-turn speech to the chat steer verb with the steer intent, never a second send', async () => {
    seam.turnActive = true
    const harness = mountVoiceMode()
    await speakAndCommit(harness)
    expect(harness.send).toHaveBeenCalledWith('hello')
    expect(harness.sendWithOutcome).not.toHaveBeenCalled()

    seam.read = { revision: 2, committed: 'hello no wait', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 1200 + 1500)
    })
    expect(harness.sendWithOutcome).toHaveBeenCalledOnce()
    const call = vi.mocked(harness.sendWithOutcome).mock.calls[0]
    expect(call[0]).toBe('no wait')
    expect(call[5]).toEqual({ steer: true })
    // The running turn was rerouted, not re-sent: still exactly one send, loop still on the turn.
    expect(harness.send).toHaveBeenCalledOnce()
    expect(harness.voiceMode().view.route).toBe('thinking')
  })

  it('never steers when idle speech starts the turn: one send through the plain chat send', async () => {
    const harness = mountVoiceMode()
    await speakAndCommit(harness)
    expect(harness.send).toHaveBeenCalledWith('hello')

    // The turn never reported active; the grace window settles it and the loop listens again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000)
    })
    expect(harness.voiceMode().view.route).toBe('listening')
    expect(harness.sendWithOutcome).not.toHaveBeenCalled()
  })

  it('a steer the chat refuses stops the loop with a visible notice', async () => {
    seam.turnActive = true
    seam.sendOutcome = 'rejected'
    const harness = mountVoiceMode()
    await speakAndCommit(harness)
    seam.read = { revision: 2, committed: 'hello go left', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 1200 + 1500)
    })

    expect(harness.showToast).toHaveBeenCalledOnce()
    expect(harness.voiceMode().view.route).toBe('closed')
  })
})

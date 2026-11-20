// The host's side of the loop's lifetime: the screen comes and goes while the loop stands, its
// words held unbound and re-armed by the rebind, until its tab closes or its worktree bounces.
import { createElement, StrictMode, useSyncExternalStore, type ReactElement } from 'react'
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
import type { NativeChatMessage } from '../../../src/shared/native-chat/native-chat-types'
import { MobileDictationHostContext } from '../dictation/mobile-dictation-host-context'
import type { MobileDictationHost } from '../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { createMobileDictationMeter } from '../hooks/mobile-dictation-meter'
import { useMobileVoiceModeHost } from './voice-mode-host-context'
import type { MobileVoiceModeLive } from './voice-mode-host-context'
import { MobileVoiceModeHostProvider } from './voice-mode-host'
import { useMobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import type { MobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import { voiceLaneAttached } from './voice-mode-host-context'
import type { MobileSessionController } from '../session/use-mobile-session-controller'
import type { MobileSessionTab } from '../session/tabs/mobile-session-tabs'
import type {
  MobileNativeChatSendIntent,
  MobileNativeChatSendOutcome
} from '../session/native-chat/composer/delivery/mobile-native-chat-send'

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
  routerPushes: string[]
  navigations: unknown[]
  speakSink: ((broadcast: SpeakBroadcast) => void) | null
  speakSubscribed: number
  speakUnsubscribed: number
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
  routerPushes: [],
  navigations: [],
  speakSink: null,
  speakSubscribed: 0,
  speakUnsubscribed: 0
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
  useRouter: () => ({
    push: (href: string) => {
      seam.routerPushes.push(href)
    }
  }),
  useNavigation: () => ({
    dispatch: (action: unknown) => {
      seam.navigations.push(action)
    },
    getState: () => ({ key: 'screen-key' })
  })
}))

vi.mock('./speak-broadcast', () => ({
  subscribeToSpeakBroadcasts: (
    _client: RpcClient,
    onBroadcast: (broadcast: SpeakBroadcast) => void
  ) => {
    seam.speakSubscribed += 1
    seam.speakSink = onBroadcast
    return () => {
      seam.speakUnsubscribed += 1
      seam.speakSink = null
    }
  }
}))

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

const HOST_ID = 'host-1'
const WORKTREE_ID = 'wt-1'
const SESSION_KEY = JSON.stringify([HOST_ID, null, WORKTREE_ID])

function fakeClient(): RpcClient {
  return {} as RpcClient
}

function terminalTab(id: string, leafId: string): MobileSessionTab {
  return {
    type: 'terminal',
    id,
    title: `Tab ${id}`,
    isActive: true,
    terminal: null,
    leafId
  }
}

type ControllerOverrides = {
  client?: RpcClient | null
  sessionTabs?: readonly MobileSessionTab[]
  activeSessionTab?: MobileSessionTab | null
  worktreeResolution?: 'present' | 'missing' | 'unknown'
}

function fakeController(
  showToast: ReturnType<typeof vi.fn>,
  send: (text: string) => Promise<boolean>,
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly unknown[],
    sentAt?: number,
    intent?: MobileNativeChatSendIntent
  ) => Promise<MobileNativeChatSendOutcome>,
  overrides: ControllerOverrides = {}
): MobileSessionController {
  // The binder reads a slice of the controller; its chat state answers live so an unbound seam still
  // reads the truth, the way the real controller's refs do.
  const nativeChatController = {
    handleNativeChatSend: send,
    handleNativeChatSendWithOutcome: sendWithOutcome,
    get nativeChatTurnActive() {
      return seam.turnActive
    },
    get nativeChatSession() {
      const reply: NativeChatMessage = {
        id: 'reply',
        role: 'assistant',
        blocks: [{ type: 'text', text: seam.replyText }],
        timestamp: 1,
        source: 'transcript'
      }
      return { messages: [reply] }
    }
  }
  return {
    hostId: HOST_ID,
    worktreeId: WORKTREE_ID,
    client: overrides.client ?? fakeClient(),
    showToast,
    worktreeResolution: overrides.worktreeResolution ?? 'present',
    sessionTabs: overrides.sessionTabs ?? [],
    activeSessionTab: overrides.activeSessionTab ?? null,
    nativeChatController
  } as unknown as MobileSessionController
}

type Harness = {
  voiceMode: () => MobileSessionVoiceMode
  view: () => MobileVoiceModeLive['view']
  owner: () => MobileVoiceModeLive['owner']
  open: () => void
  showToast: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  sendWithOutcome: ReturnType<typeof vi.fn>
  refresh: (overrides?: ControllerOverrides) => void
  unbindScreen: () => void
  rebindScreen: () => void
  broadcast: (broadcast: SpeakBroadcast) => void
  subscriptionLive: () => boolean
  unmount: () => void
}

function mountVoiceModeHost(options: { strict?: boolean } = {}): Harness {
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
  let controller = fakeController(showToast, send, sendWithOutcome)
  let held: { voice: MobileSessionVoiceMode; open: () => void } | null = null
  // Stays mounted across the screen's comings and goings, so the loop's view reads true while unbound.
  let live: MobileVoiceModeLive | null = null
  function Probe(): null {
    held = { voice: useMobileSessionVoiceMode(controller), open: useMobileVoiceModeHost().open }
    return null
  }
  function Watcher(): null {
    const host = useMobileVoiceModeHost()
    live = useSyncExternalStore(host.subscribe, host.getLive)
    return null
  }
  let renderer: ReactTestRenderer
  const providers = (screen: ReactElement | null): ReactElement => {
    const inner = createElement(
      MobileDictationHostContext.Provider,
      { value: dictationHost },
      createElement(MobileVoiceModeHostProvider, null, createElement(Watcher), screen)
    )
    return options.strict === true ? createElement(StrictMode, null, inner) : inner
  }
  const swap = (screen: ReactElement | null) => {
    act(() => {
      renderer.update(providers(screen))
    })
  }
  act(() => {
    renderer = create(providers(createElement(Probe)))
  })
  return {
    voiceMode: () => {
      if (held === null) {
        throw new Error('no screen mounted')
      }
      return held.voice
    },
    view: () => {
      if (live === null) {
        throw new Error('the watcher rendered without a live store')
      }
      return live.view
    },
    owner: () => live?.owner ?? null,
    open: () => {
      if (held === null) {
        throw new Error('no screen mounted')
      }
      held.open()
    },
    showToast,
    send,
    sendWithOutcome,
    refresh: (overrides = {}) => {
      controller = fakeController(showToast, send, sendWithOutcome, overrides)
      swap(createElement(Probe))
    },
    unbindScreen: () => swap(null),
    rebindScreen: () => swap(createElement(Probe)),
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

async function startLoop(harness: Harness): Promise<void> {
  await act(async () => {
    harness.voiceMode().start()
    await flushEntry()
  })
}

// Speaks one committed utterance through the loop's default timings: read at 150ms, silence window 1200ms, delay 1500ms.
async function speak(harness: Harness, revision: number, text: string): Promise<void> {
  seam.read = { revision, committed: text, tentative: '', failure: null }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150 + 1200 + 1500)
  })
}

describe('MobileVoiceModeHostProvider', () => {
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
    seam.routerPushes.length = 0
    seam.navigations.length = 0
    seam.speakSink = null
    seam.speakSubscribed = 0
    seam.speakUnsubscribed = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('starts the loop on a bound screen and holds the broadcasts on its session', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    expect(harness.view().route).toBe('listening')
    expect(seam.calls).toContain('speech.start')
    expect(seam.calls).toContain('capture.open')
    expect(harness.voiceMode().entryAvailable).toBe(true)
    expect(harness.subscriptionLive()).toBe(true)
    expect(seam.speakSubscribed).toBe(1)
    expect(harness.owner()?.sessionKey).toBe(SESSION_KEY)
  })

  it('keeps the loop when the chat hides, still sending what is spoken over it', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    await speak(harness, 1, 'hello')
    expect(harness.send).toHaveBeenCalledWith('hello')
    // The turn never reported active; the grace window settles it and the loop listens again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000)
    })
    expect(harness.view().route).toBe('listening')

    // The chat's hiding once ended the loop; now the words still ride the held lane. The committed
    // stream already holds the first utterance, so the send carries only the newly spoken words.
    harness.refresh()
    await speak(harness, 2, 'hello more words')
    expect(harness.send).toHaveBeenNthCalledWith(2, 'more words')
    expect(harness.view().route).not.toBe('closed')
  })

  it('unbinds when the screen leaves, holding its words unsent and its broadcasts live', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    harness.unbindScreen()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200 + 1500 + 2000)
    })
    expect(harness.send).not.toHaveBeenCalled()
    expect(harness.view().pending).toBeNull()
    // The loop still owns its session: the broadcasts follow the last client it was seen on.
    expect(harness.subscriptionLive()).toBe(true)
  })

  it('re-arms the held words on the rebind and sends them', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    harness.unbindScreen()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200 + 1500 + 2000)
    })
    expect(harness.send).not.toHaveBeenCalled()

    harness.rebindScreen()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 1200 + 1500 + 500)
    })
    expect(harness.send).toHaveBeenCalledOnce()
    expect(harness.send).toHaveBeenCalledWith('hello')
  })

  it('holds a commit that came due unbound, clearing its pending view but keeping its words', async () => {
    seam.turnActive = true
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 1200)
    })
    expect(harness.view().pending).toBe('hello')

    harness.unbindScreen()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500 + 1000)
    })
    expect(harness.send).not.toHaveBeenCalled()
    expect(harness.view().pending).toBeNull()

    harness.rebindScreen()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 1500 + 500)
    })
    expect(harness.send).toHaveBeenCalledOnce()
    expect(harness.send).toHaveBeenCalledWith('hello')
  })

  it('pauses the reply poll while unbound and settles it after the rebind', async () => {
    seam.turnActive = true
    seam.replyText = 'Done speaking.'
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    await speak(harness, 1, 'hello')
    expect(harness.send).toHaveBeenCalledWith('hello')

    harness.unbindScreen()
    seam.turnActive = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    // The poll froze with the seam: the settled turn never spoke, the loop never moved.
    expect(seam.ttsSpeakCalls).toEqual([])
    expect(harness.view().route).toBe('thinking')

    harness.rebindScreen()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 150 + 100)
    })
    expect(seam.ttsSpeakCalls).toEqual([{ text: 'Done speaking.', locale: null }])
    expect(harness.view().route).toBe('listening')
  })

  it('re-runs the speak subscription when a rebound screen carries a different client', async () => {
    const second = fakeClient()
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    expect(seam.speakSubscribed).toBe(1)

    harness.refresh({ client: second })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(seam.speakSubscribed).toBe(2)
    expect(harness.subscriptionLive()).toBe(true)

    harness.unbindScreen()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    // No seam stands, but the session's newest client still carries the broadcasts.
    expect(harness.subscriptionLive()).toBe(true)
    expect(seam.speakSubscribed).toBe(2)
  })

  it('ends the loop when its tab closes, releasing the screen and the microphone', async () => {
    const leafId = crypto.randomUUID()
    const tab = terminalTab('tab-1', leafId)
    const harness = mountVoiceModeHost()
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab] })
    await startLoop(harness)
    expect(harness.view().route).toBe('listening')
    expect(harness.owner()?.paneKey).toBe(`tab-1:${leafId}`)

    // The owning tab closed: the loop must not outlive the chat it runs on.
    harness.refresh({ activeSessionTab: tab, sessionTabs: [] })
    await act(async () => {
      await flushEntry()
    })
    expect(harness.view().route).toBe('closed')
    expect(seam.calls).toContain('screen.release')
    expect(seam.calls).toContain('speech.cancel')
    expect(seam.calls).toContain('capture.end')
    expect(harness.subscriptionLive()).toBe(false)
  })

  it('ends the loop when its worktree bounces as missing', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    harness.refresh({ worktreeResolution: 'missing' })
    await act(async () => {
      await flushEntry()
    })
    expect(harness.view().route).toBe('closed')
    expect(seam.calls).toContain('screen.release')
  })

  it('brings the chat back through the mounted screen, or opens its route when none stands', async () => {
    const leafId = crypto.randomUUID()
    const tab = terminalTab('tab-1', leafId)
    const harness = mountVoiceModeHost()
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab] })
    await startLoop(harness)
    harness.unbindScreen()
    harness.open()
    expect(seam.routerPushes).toEqual([
      `/h/${HOST_ID}/session/${WORKTREE_ID}?paneKey=${encodeURIComponent(`tab-1:${leafId}`)}`
    ])

    harness.rebindScreen()
    harness.open()
    expect(seam.navigations).toHaveLength(1)
    const action = seam.navigations[0] as {
      type: string
      payload: { params?: { paneKey?: string } }
    }
    expect(action.type).toBe('POP_TO')
    expect(action.payload.params?.paneKey).toBe(`tab-1:${leafId}`)
  })

  it('starts one loop under StrictMode double-mounting and sends the words once', async () => {
    seam.turnActive = true
    const harness = mountVoiceModeHost({ strict: true })
    await startLoop(harness)
    await speak(harness, 1, 'hello')
    expect(harness.send).toHaveBeenCalledOnce()
    expect(harness.send).toHaveBeenCalledWith('hello')
    expect(seam.speakSubscribed).toBe(1)
    expect(harness.view().route).toBe('thinking')
  })
})

describe('voiceLaneAttached', () => {
  const otherSession = JSON.stringify(['host-1', null, 'wt-2'])

  it('holds the lane attached while shown or while the loop runs on the session', () => {
    expect(voiceLaneAttached(true, null, SESSION_KEY)).toBe(true)
    expect(voiceLaneAttached(true, otherSession, SESSION_KEY)).toBe(true)
    expect(voiceLaneAttached(false, SESSION_KEY, SESSION_KEY)).toBe(true)
    expect(voiceLaneAttached(false, null, SESSION_KEY)).toBe(false)
    expect(voiceLaneAttached(false, otherSession, SESSION_KEY)).toBe(false)
  })
})

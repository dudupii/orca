// The host's side of the loop's lifetime: the screen comes and goes while the loop stands, its
// words held unbound and re-armed by the rebind, until the host server proves its pane or
// worktree gone — asked of the wire, so the watch outlives the screen that started it.
import { createElement, StrictMode, useSyncExternalStore, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DictationCapture,
  DictationCaptureOpen
} from '../platform/audio-capture/dictation-capture-contract'
import type { OnDeviceSpeech } from '../platform/speech/on-device-speech-contract'
import type { OnDeviceTone, OnDeviceToneKind } from '../platform/tone/on-device-tone-contract'
import type { OnDeviceTtsChannelStatus } from '../platform/tts/on-device-tts-contract'
import type {
  BridgeSpeechRead,
  BridgeSpeechStartResult
} from '../mobile-web-shell/bridge/native-capabilities/bridge-speech-verbs'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileDictationHostContext } from '../dictation/mobile-dictation-host-context'
import type { MobileDictationHost } from '../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { createMobileDictationMeter } from '../hooks/mobile-dictation-meter'
import { useMobileVoiceModeHost } from './voice-mode-host-context'
import type { MobileVoiceModeLive, MobileVoiceModeOwnerChat } from './voice-mode-host-context'
import { MobileVoiceModeHostProvider } from './voice-mode-host'
import { useMobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import type { MobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import { VOICE_MODE_OWNER_LIVENESS_POLL_MS } from './voice-mode-owner-liveness'
import { loadVoiceModeBargeIn } from '../storage/voice-mode-settings'
import type { MobileSessionController } from '../session/use-mobile-session-controller'
import type { MobileSessionTab } from '../session/tabs/mobile-session-tabs'
import type {
  MobileNativeChatSendIntent,
  MobileNativeChatSendOutcome
} from '../session/native-chat/composer/delivery/mobile-native-chat-send'

type SpeakBroadcast = { text: string; lang: string | null; session: string | null }

// What the fake client answers the liveness probe's session-tabs read with; 'refused' proves nothing.
type LivenessTabsAnswer = { tabs: unknown[]; agentSessionsUnverifiable?: true } | 'refused'

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
  tone: OnDeviceTone | null
  toneCalls: string[]
  sendOutcome: MobileNativeChatSendOutcome
  routerPushes: string[]
  navigations: unknown[]
  speakSink: ((broadcast: SpeakBroadcast) => void) | null
  speakSubscribed: number
  speakUnsubscribed: number
  speakClients: RpcClient[]
  worktreeMissing: boolean
  sessionTabs: LivenessTabsAnswer
  livenessRequests: string[]
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
  tone: null,
  toneCalls: [],
  sendOutcome: 'accepted',
  routerPushes: [],
  navigations: [],
  speakSink: null,
  speakSubscribed: 0,
  speakUnsubscribed: 0,
  speakClients: [],
  worktreeMissing: false,
  sessionTabs: { tabs: [] },
  livenessRequests: []
}))

// The AppState the host subscribes to: change handlers only ever registered for 'change', fired by hand.
const appState = vi.hoisted(() => ({
  listeners: [] as ((state: string) => void)[],
  subscribedTypes: [] as string[],
  fire: (state: string) => {
    for (const listener of appState.listeners) {
      listener(state)
    }
  }
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

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (type: string, handler: (state: string) => void) => {
      appState.subscribedTypes.push(type)
      appState.listeners.push(handler)
      return {
        remove: () => {
          const at = appState.listeners.indexOf(handler)
          if (at !== -1) {
            appState.listeners.splice(at, 1)
          }
        }
      }
    }
  }
}))

vi.mock('../platform/tone/on-device-tone', () => ({
  useOnDeviceTone: () => seam.tone
}))

// A tone whose every chime records how many playbacks had begun when it sounded, pinning order.
function recordingTone(): OnDeviceTone {
  return {
    play: (kind: OnDeviceToneKind) => {
      seam.toneCalls.push(`${kind}@${seam.ttsSpeakCalls.length}`)
    }
  }
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
    client: RpcClient,
    onBroadcast: (broadcast: SpeakBroadcast) => void
  ) => {
    seam.speakSubscribed += 1
    seam.speakClients.push(client)
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

// A connected client whose host server answers the liveness reads from the seam's state; anything
// else it is asked answers empty, so only the liveness probes notice it.
function fakeClient(): RpcClient {
  return {
    getState: () => 'connected',
    sendRequest: async (method: string) => {
      seam.livenessRequests.push(method)
      if (method === 'worktree.show') {
        return seam.worktreeMissing
          ? {
              id: 1,
              ok: false,
              error: { code: 'selector_not_found', message: 'selector_not_found' }
            }
          : { id: 1, ok: true, result: {} }
      }
      if (method === 'session.tabs.list') {
        const answer = seam.sessionTabs
        return answer === 'refused'
          ? { id: 1, ok: false, error: { code: 'runtime_error', message: 'refused' } }
          : {
              id: 1,
              ok: true,
              result: {
                tabs: answer.tabs,
                ...(answer.agentSessionsUnverifiable ? { agentSessionsUnverifiable: true } : {})
              }
            }
      }
      return { id: 1, ok: true, result: null }
    }
  } as unknown as RpcClient
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

// The wire shape the liveness read's session-tabs answer carries for a standing pane.
function rawPaneTab(tab: {
  type: string
  id: string
  title: string
  leafId?: string
}): Record<string, unknown> {
  return { type: tab.type, id: tab.id, title: tab.title, isActive: true, leafId: tab.leafId }
}

type ControllerOverrides = {
  client?: RpcClient | null
  sessionTabs?: readonly MobileSessionTab[]
  activeSessionTab?: MobileSessionTab | null
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
  // The binder reads a slice of the controller; its captured seam answers live so an unbound seam
  // still reads the truth, the way the real controller's refs do.
  const nativeChatController = {
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
  return {
    hostId: HOST_ID,
    worktreeId: WORKTREE_ID,
    client: overrides.client ?? fakeClient(),
    showToast,
    sessionTabs: overrides.sessionTabs ?? [],
    activeSessionTab: overrides.activeSessionTab ?? null,
    showNativeChat: true,
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
  stackScreen: (tab: MobileSessionTab) => void
  stackedSend: ReturnType<typeof vi.fn>
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
  // A stacked copy of the same session stands on another pane; its chat must never answer for the owner's.
  const stackedSend = vi.fn(async () => true)
  const stackedSendWithOutcome = vi.fn(
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
  let stackedController: MobileSessionController | null = null
  let held: { voice: MobileSessionVoiceMode; open: () => void } | null = null
  // Stays mounted across the screens' comings and goings, so the loop's view reads true while unbound.
  let live: MobileVoiceModeLive | null = null
  function Probe(): null {
    held = { voice: useMobileSessionVoiceMode(controller), open: useMobileVoiceModeHost().open }
    return null
  }
  // Mounted only while a stacked screen stands; its controller is set before the element exists.
  function StackedProbe(): null {
    useMobileSessionVoiceMode(stackedController ?? controller)
    return null
  }
  function Watcher(): null {
    const host = useMobileVoiceModeHost()
    live = useSyncExternalStore(host.subscribe, host.getLive)
    return null
  }
  let renderer: ReactTestRenderer
  let ownerScreen: ReactElement | null = createElement(Probe)
  let stackedScreen: ReactElement | null = null
  const providers = (): ReactElement => {
    const inner = createElement(
      MobileDictationHostContext.Provider,
      { value: dictationHost },
      createElement(
        MobileVoiceModeHostProvider,
        null,
        createElement(Watcher),
        ownerScreen,
        stackedScreen
      )
    )
    return options.strict === true ? createElement(StrictMode, null, inner) : inner
  }
  const swap = () => {
    act(() => {
      renderer.update(providers())
    })
  }
  act(() => {
    renderer = create(providers())
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
    stackedSend,
    refresh: (overrides = {}) => {
      controller = fakeController(showToast, send, sendWithOutcome, overrides)
      ownerScreen = createElement(Probe)
      swap()
    },
    unbindScreen: () => {
      ownerScreen = null
      swap()
    },
    rebindScreen: () => {
      ownerScreen = createElement(Probe)
      swap()
    },
    stackScreen: (tab) => {
      stackedController = fakeController(showToast, stackedSend, stackedSendWithOutcome, {
        activeSessionTab: tab,
        sessionTabs: [tab]
      })
      stackedScreen = createElement(StackedProbe)
      swap()
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
    seam.tone = null
    seam.toneCalls.length = 0
    appState.listeners.length = 0
    appState.subscribedTypes.length = 0
    seam.sendOutcome = 'accepted'
    seam.routerPushes.length = 0
    seam.navigations.length = 0
    seam.speakSink = null
    seam.speakSubscribed = 0
    seam.speakUnsubscribed = 0
    seam.speakClients.length = 0
    seam.worktreeMissing = false
    seam.sessionTabs = { tabs: [] }
    seam.livenessRequests.length = 0
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

  it('freezes a reply poll whose send resolved after the unbind, settling only on the rebound seam', async () => {
    seam.replyText = 'The reply that survived the unbind.'
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    // The send is in flight when its seam leaves; its wait — registered before the send awaited —
    // pauses with the unbind, so it accepts into a poll that can never run against no chat.
    let releaseSend: ((accepted: boolean) => void) | null = null
    harness.send.mockImplementation(
      () => new Promise<boolean>((resolve) => (releaseSend = resolve))
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200 + 1500 + 100)
    })
    expect(harness.send).toHaveBeenCalledWith('hello')
    harness.unbindScreen()
    await act(async () => {
      releaseSend?.(true)
      await flushEntry()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(harness.view().route).toBe('thinking')
    expect(seam.ttsSpeakCalls).toEqual([])

    // The rebind resumes the poll against the live seam; its settled turn speaks the real reply.
    harness.rebindScreen()
    seam.turnActive = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    seam.turnActive = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 150 + 100)
    })
    expect(seam.ttsSpeakCalls).toEqual([
      { text: 'The reply that survived the unbind.', locale: null }
    ])
    expect(harness.view().route).toBe('listening')
  })

  it('freezes an unbind stretch out of the reply clocks when the send resolves after the rebind', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    let releaseSend: ((accepted: boolean) => void) | null = null
    harness.send.mockImplementation(
      () => new Promise<boolean>((resolve) => (releaseSend = resolve))
    )
    // The send pends while its seam stands bound; its wait's clock runs most of the grace window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200 + 1500 + 100)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000)
    })
    expect(harness.view().route).toBe('thinking')

    harness.unbindScreen()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    // The unbound stretch is frozen out of the wait's clocks, so it cannot settle against nothing.
    expect(harness.view().route).toBe('thinking')
    harness.rebindScreen()
    await act(async () => {
      releaseSend?.(true)
      await flushEntry()
    })
    // The bound time alone has passed — still inside the grace window — so the polls hold for a
    // turn that never started instead of the whole wall since the send settling them at once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(harness.view().route).toBe('thinking')
    // Past the grace window on the send's bound time the wait settles and the loop listens again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
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

  it('subscribes the broadcasts on the client the settings load straddled in', async () => {
    let releaseLoad: ((value: true) => void) | null = null
    const gated = new Promise<true>((resolve) => (releaseLoad = resolve))
    vi.mocked(loadVoiceModeBargeIn).mockReturnValue(gated)
    const second = fakeClient()
    const harness = mountVoiceModeHost()
    await act(async () => {
      harness.voiceMode().start()
      await flushEntry()
    })
    expect(seam.speakSubscribed).toBe(0)

    // The starting screen's client changed while the settings loaded; the broadcasts must follow
    // the newest binding's client, not the one start captured.
    harness.refresh({ client: second })
    await act(async () => {
      releaseLoad?.(true)
      await flushEntry()
    })
    expect(seam.speakSubscribed).toBe(1)
    expect(seam.speakClients[0]).toBe(second)

    const third = fakeClient()
    harness.refresh({ client: third })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(seam.speakUnsubscribed).toBe(1)
    expect(seam.speakSubscribed).toBe(2)
    expect(seam.speakClients[1]).toBe(third)
  })

  it('ends the loop when its pane is proven closed, releasing the screen and the microphone', async () => {
    const leafId = crypto.randomUUID()
    const tab = terminalTab('tab-1', leafId)
    const harness = mountVoiceModeHost()
    seam.sessionTabs = { tabs: [rawPaneTab(tab)] }
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab] })
    await startLoop(harness)
    expect(harness.view().route).toBe('listening')
    expect(harness.owner()?.paneKey).toBe(`tab-1:${leafId}`)

    // The owning pane closed: the host server's own answers end the loop, screen or not.
    seam.sessionTabs = { tabs: [] }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MODE_OWNER_LIVENESS_POLL_MS * 2 + 100)
    })
    expect(harness.view().route).toBe('closed')
    expect(seam.calls).toContain('screen.release')
    expect(seam.calls).toContain('speech.cancel')
    expect(seam.calls).toContain('capture.end')
    expect(harness.subscriptionLive()).toBe(false)
  })

  it('ends the loop when its worktree is proven missing', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    seam.worktreeMissing = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MODE_OWNER_LIVENESS_POLL_MS * 2 + 100)
    })
    expect(harness.view().route).toBe('closed')
    expect(seam.calls).toContain('screen.release')
  })

  it('ends the loop on a pane proven closed after its screen left, releasing what it holds', async () => {
    const leafId = crypto.randomUUID()
    const tab = terminalTab('tab-1', leafId)
    const harness = mountVoiceModeHost()
    seam.sessionTabs = { tabs: [rawPaneTab(tab)] }
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab] })
    await startLoop(harness)
    harness.unbindScreen()
    // No screen stands for the chat anymore; only the page's own watch can see the pane go.
    seam.sessionTabs = { tabs: [] }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MODE_OWNER_LIVENESS_POLL_MS * 2 + 100)
    })
    expect(harness.view().route).toBe('closed')
    expect(seam.calls).toContain('screen.release')
    expect(seam.calls).toContain('speech.cancel')
    expect(seam.calls).toContain('capture.end')
    expect(harness.subscriptionLive()).toBe(false)
  })

  it('ends the loop when its paneless owning tab is proven closed after its screen left', async () => {
    // A terminal tab without a leaf names no pane; the loop's lifetime watches the tab itself.
    const tab = {
      type: 'terminal',
      id: 'tab-1',
      title: 'Tab tab-1',
      isActive: true,
      terminal: null
    } satisfies MobileSessionTab
    const harness = mountVoiceModeHost()
    seam.sessionTabs = { tabs: [rawPaneTab({ type: 'terminal', id: 'tab-1', title: 'Tab tab-1' })] }
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab] })
    await startLoop(harness)
    expect(harness.owner()?.paneKey).toBeUndefined()
    expect(harness.owner()?.tabId).toBe('tab-1')

    harness.unbindScreen()
    // The paneless tab still stands; the loop keeps running with its screen gone.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MODE_OWNER_LIVENESS_POLL_MS * 2 + 100)
    })
    expect(harness.view().route).toBe('listening')

    // The tab's removal ends the loop the way a pane's does, with everything it holds released.
    seam.sessionTabs = { tabs: [] }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MODE_OWNER_LIVENESS_POLL_MS * 2 + 100)
    })
    expect(harness.view().route).toBe('closed')
    expect(seam.calls).toContain('screen.release')
    expect(seam.calls).toContain('speech.cancel')
    expect(seam.calls).toContain('capture.end')
    expect(harness.subscriptionLive()).toBe(false)
  })

  it('keeps the loop while the liveness reads cannot prove the pane or the worktree gone', async () => {
    const leafId = crypto.randomUUID()
    const tab = terminalTab('tab-1', leafId)
    const harness = mountVoiceModeHost()
    seam.sessionTabs = { tabs: [rawPaneTab(tab)] }
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab] })
    await startLoop(harness)

    // A missed pane read, a refused tabs answer, and one missing worktree read: none of it agrees
    // twice, so nothing ends — the pane coming back resets it, as does the worktree.
    seam.sessionTabs = { tabs: [] }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MODE_OWNER_LIVENESS_POLL_MS)
    })
    seam.sessionTabs = 'refused'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MODE_OWNER_LIVENESS_POLL_MS)
    })
    seam.worktreeMissing = true
    seam.sessionTabs = { tabs: [rawPaneTab(tab)] }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MODE_OWNER_LIVENESS_POLL_MS)
    })
    seam.worktreeMissing = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MODE_OWNER_LIVENESS_POLL_MS * 2 + 100)
    })
    expect(harness.view().route).toBe('listening')
    expect(harness.subscriptionLive()).toBe(true)
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

  it('keeps the loop sending through the screen that started it when its session stacks another', async () => {
    const leafId = crypto.randomUUID()
    const otherLeaf = crypto.randomUUID()
    const tab = terminalTab('tab-1', leafId)
    const other = terminalTab('tab-2', otherLeaf)
    const harness = mountVoiceModeHost()
    seam.sessionTabs = { tabs: [rawPaneTab(tab), rawPaneTab(other)] }
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab] })
    await startLoop(harness)

    // A second screen of the same session binds after the owner's; every screen of the session
    // serves the same captured chat, and the one that started the loop stands for it.
    harness.stackScreen(other)
    await speak(harness, 1, 'hello')
    expect(harness.send).toHaveBeenCalledWith('hello')
    expect(harness.stackedSend).not.toHaveBeenCalled()
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

  it('settles the reply wait and stops the loop cleanly when the send rejects while bound', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    harness.send.mockImplementation(() => Promise.reject(new Error('chat refused the write')))
    await speak(harness, 1, 'hello')
    expect(harness.send).toHaveBeenCalledWith('hello')

    // The rejection settles the wait it pre-registered — nothing of its turn keeps polling — and
    // the failure still reaches the loop: the send-failed notice toasts and the loop closes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(harness.showToast).toHaveBeenCalledWith(
      'Voice mode stopped: the message could not be sent.'
    )
    expect(harness.view().route).toBe('closed')
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.send).toHaveBeenCalledOnce()
  })

  it('parks nothing when the send rejects after the unbind, and a fresh loop sends again', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    let rejectSend: ((err: Error) => void) | null = null
    harness.send.mockImplementation(
      () => new Promise<boolean>((_, reject) => (rejectSend = reject))
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200 + 1500 + 100)
    })
    expect(harness.send).toHaveBeenCalledWith('hello')
    harness.unbindScreen()
    await act(async () => {
      rejectSend?.(new Error('chat gone with the screen'))
      await flushEntry()
    })

    // No wait stays paused forever against a chat that failed definitively: the loop closes with
    // everything released, and nothing polls on.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(harness.view().route).toBe('closed')
    expect(vi.getTimerCount()).toBe(0)

    // The closed loop is gone for good; a fresh one starts and its sends ride the seam again.
    harness.rebindScreen()
    harness.send.mockImplementation(async () => true)
    await startLoop(harness)
    await speak(harness, 1, 'afresh')
    expect(harness.send).toHaveBeenCalledWith('afresh')
  })

  it('pauses the loop when the app backgrounds and resumes it on the return, change events only', async () => {
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    expect(seam.calls.filter((call) => call === 'capture.open')).toHaveLength(1)
    // Only 'change' is ever subscribed: Android's blur and focus for the app's own sheets reach nothing.
    expect(appState.subscribedTypes).toEqual(['change'])

    await act(async () => {
      appState.fire('background')
    })
    expect(seam.calls.filter((call) => call === 'capture.end')).toHaveLength(1)
    expect(harness.view().route).toBe('listening')

    await act(async () => {
      appState.fire('active')
    })
    expect(seam.calls.filter((call) => call === 'capture.open')).toHaveLength(2)
    expect(seam.calls.filter((call) => call === 'capture.begin')).toHaveLength(2)
    expect(seam.calls.filter((call) => call === 'capture.end')).toHaveLength(1)
  })

  it('chimes and speaks the parked reply when one landed while backgrounded', async () => {
    seam.tone = recordingTone()
    seam.replyText = 'Answered while away.'
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    await speak(harness, 1, 'hello')
    expect(harness.send).toHaveBeenCalledWith('hello')

    await act(async () => {
      appState.fire('background')
    })
    // The turn's grace window runs out while away; its reply parks instead of playing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000)
    })
    expect(harness.view().route).toBe('speaking')
    expect(seam.ttsSpeakCalls).toEqual([])

    await act(async () => {
      appState.fire('active')
    })
    // The chime precedes the playback it announces; the microphone reopened after both.
    expect(seam.toneCalls).toEqual(['restore@0'])
    expect(seam.ttsSpeakCalls).toEqual([{ text: 'Answered while away.', locale: null }])
    expect(seam.calls.filter((call) => call === 'capture.open')).toHaveLength(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150 + 300)
    })
    expect(harness.view().route).toBe('listening')
  })

  it('keeps a return with nothing advanced silent, and never chimes a navigation or a tap', async () => {
    seam.tone = recordingTone()
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    await act(async () => {
      appState.fire('background')
    })
    await act(async () => {
      appState.fire('active')
    })
    expect(seam.toneCalls).toEqual([])

    // Bringing the chat back and tapping at the loop are not returns from away: no chime, ever.
    harness.open()
    act(() => {
      harness.voiceMode().tapPending()
      harness.voiceMode().stopSpeaking()
    })
    expect(seam.toneCalls).toEqual([])
  })

  it('chimes a straddling turn as its reply answers after the return', async () => {
    seam.tone = recordingTone()
    seam.turnActive = true
    seam.replyText = 'The answer that outlasted the away.'
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    await speak(harness, 1, 'hello')

    await act(async () => {
      appState.fire('background')
    })
    await act(async () => {
      appState.fire('active')
    })
    // The turn still ran at the return: a silent restore, with the microphone back.
    expect(seam.toneCalls).toEqual([])
    expect(seam.calls.filter((call) => call === 'capture.open')).toHaveLength(2)

    seam.turnActive = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 100)
    })
    expect(seam.toneCalls).toEqual(['restore@0'])
    expect(seam.ttsSpeakCalls).toEqual([
      { text: 'The answer that outlasted the away.', locale: null }
    ])
  })

  // The speak contract's session gate, judged against the chat the loop captured at its start: a
  // broadcast naming another conversation's session never reaches the readout, whatever tab is
  // live now; an unaddressed one names no one and stays audible.
  it('speaks the briefing a broadcast names for the chat the loop captured', async () => {
    seam.turnActive = true
    seam.replyText = 'A very long reply. Not the readout. More words here.'
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    await speak(harness, 1, 'hello')

    harness.broadcast({ text: 'Briefed words.', lang: null, session: 'session-1' })
    seam.turnActive = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 150 + 300)
    })
    expect(seam.ttsSpeakCalls).toEqual([{ text: 'Briefed words.', locale: null }])
    expect(harness.view().route).toBe('listening')
  })

  it('drops a briefing naming another session, so the reply prose speaks', async () => {
    seam.turnActive = true
    seam.replyText = 'The build passed. Tests are green.'
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    await speak(harness, 1, 'hello')

    harness.broadcast({ text: 'Not ours.', lang: null, session: 'session-2' })
    seam.turnActive = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 150 + 300)
    })
    expect(seam.ttsSpeakCalls).toEqual([
      { text: 'The build passed. Tests are green.', locale: null }
    ])
    expect(harness.view().route).toBe('listening')
  })

  it('plays an unaddressed briefing even while a conversation owns the loop', async () => {
    seam.turnActive = true
    seam.replyText = 'A very long reply. Not the readout. More words here.'
    const harness = mountVoiceModeHost()
    await startLoop(harness)
    await speak(harness, 1, 'hello')

    harness.broadcast({ text: 'For every listener.', lang: 'zh-CN', session: null })
    seam.turnActive = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250 + 150 + 300)
    })
    expect(seam.ttsSpeakCalls).toEqual([{ text: 'For every listener.', locale: 'zh-CN' }])
    expect(harness.view().route).toBe('listening')
  })
})

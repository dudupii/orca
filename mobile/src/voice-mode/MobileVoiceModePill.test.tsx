// The pill that stands in for the chat while the voice loop runs elsewhere: the state it shows,
// when it stands (away from the conversation only — the screen gone, covered, or showing its
// terminal), where its taps go, and the notices it carries while no screen shows the chat.
import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
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
import { MobileDictationHostContext } from '../dictation/mobile-dictation-host-context'
import type { MobileDictationHost } from '../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { createMobileDictationMeter } from '../hooks/mobile-dictation-meter'
import {
  MobileVoiceModeHostContext,
  MobileVoiceModePillContext,
  useMobileVoiceModeHost
} from './voice-mode-host-context'
import type {
  MobileVoiceModeHost,
  MobileVoiceModeLive,
  MobileVoiceModeOwner,
  MobileVoiceModeOwnerChat,
  MobileVoiceModePill
} from './voice-mode-host-context'
import { MobileVoiceModeHostProvider } from './voice-mode-host'
import { MobileVoiceModePillLayer } from './MobileVoiceModePill'
import { useMobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import type { MobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import type { MobileSessionController } from '../session/use-mobile-session-controller'
import type { MobileSessionTab } from '../session/tabs/mobile-session-tabs'
import type { VoiceLoopRoute, VoiceLoopView } from './voice-loop-shell-contract'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

type SpeakBroadcast = { text: string; lang: string | null; session: string | null }

// What the fake client answers the liveness probe's session-tabs read with; 'refused' proves nothing.
type LivenessTabsAnswer = { tabs: unknown[] } | 'refused'

type Seam = {
  calls: string[]
  read: BridgeSpeechRead
  speechStartResult: BridgeSpeechStartResult | Error
  openResult: DictationCaptureOpen | Error
  beginResult: boolean | Error
  turnActive: boolean
  replyText: string
  ttsStatus: OnDeviceTtsChannelStatus
  ttsSpeakCalls: { text: string; locale: string | null }[]
  ttsStopCalls: number
  routerPushes: string[]
  navigations: unknown[]
  tabViewSets: [tabId: string, view: string][]
  worktreeMissing: boolean
  sessionTabs: LivenessTabsAnswer
}

const seam = vi.hoisted((): Seam => ({
  calls: [],
  read: { revision: 0, committed: '', tentative: '', failure: null },
  speechStartResult: { started: true, locale: 'en-US', reason: null },
  openResult: { ok: true },
  beginResult: true,
  turnActive: false,
  replyText: '',
  ttsStatus: 'done',
  ttsSpeakCalls: [],
  ttsStopCalls: 0,
  routerPushes: [],
  navigations: [],
  tabViewSets: [],
  worktreeMissing: false,
  sessionTabs: { tabs: [] }
}))

// The screen's focus, as the expo-router mock answers it; the harness flips it to cover the chat.
const focus = vi.hoisted(() => ({ inFront: true }))

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

// The host subscribes to AppState; the pill harness keeps the app forever active.
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, _handler: (state: string) => void) => ({ remove: () => {} })
  },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('lucide-react-native', () => ({ X: 'XIcon' }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

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
// The device-locale seam pulls expo-localization, which no vitest run defines; the loop only
// needs a stable locale to resolve a lang-less readout against.
vi.mock('../platform/speech/on-device-speech-locale', () => ({
  onDeviceSpeechLocale: vi.fn(() => 'en-US')
}))

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
      seam.ttsStatus = 'stopped'
      return Promise.resolve()
    },
    read: () => Promise.resolve({ revision, status: seam.ttsStatus, reason: null })
  }
  return { useOnDeviceTts: () => channel }
})

vi.mock('../storage/voice-mode-settings', () => ({
  VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS: 1.5,
  loadVoiceModeResponseDelaySeconds: vi.fn(async () => 1.5),
  saveVoiceModeResponseDelaySeconds: vi.fn(async () => {}),
  loadVoiceModeBargeIn: vi.fn(async () => true),
  saveVoiceModeBargeIn: vi.fn(async () => {}),
  loadVoiceModeFallbackReadout: vi.fn(async () => true),
  loadVoiceModeReadoutLanguage: vi.fn(async () => ({ mode: 'automatic' })),
  saveVoiceModeFallbackReadout: vi.fn(async () => {})
}))

vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      // Focus the harness commands: the effect runs while in front, its cleanup when covered.
      useEffect(() => (focus.inFront ? effect() : undefined), [effect, focus.inFront])
    },
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
  }
})

vi.mock('./speak-broadcast', () => ({
  subscribeToSpeakBroadcasts:
    (_client: RpcClient, _onBroadcast: (b: SpeakBroadcast) => void) => () => {}
}))

let renderer: ReactTestRenderer | null = null

function unmountRendered(): void {
  if (renderer !== null) {
    act(() => renderer?.unmount())
    renderer = null
  }
}

function textContents(root: ReactTestInstance): string[] {
  return findAllByHostType(root, 'Text').map((node) => String(node.props.children))
}

function pressableByLabel(root: ReactTestInstance, label: string): ReactTestInstance | undefined {
  return findAllByHostType(root, 'Pressable').find(
    (node) => node.props.accessibilityLabel === label
  )
}

const OWNER: MobileVoiceModeOwner = {
  instance: {},
  sessionKey: '["host-1",null,"wt-1"]',
  client: null,
  worktreeId: 'wt-1',
  href: '/h/host-1/session/wt-1',
  paneKey: undefined,
  tabId: 'tab-1',
  title: 'Claude Code',
  chat: null
}

const loopView = (route: VoiceLoopRoute): VoiceLoopView => ({
  route,
  transcript: '',
  pending: null,
  reply: null
})

const SEND_FAILED = 'Voice mode stopped: the message could not be sent.'

type PillOptions = {
  view: VoiceLoopView
  owner?: MobileVoiceModeOwner | null
  away?: boolean
  toast?: string | null
}

// The fake host is the pill's whole seam — host verbs and the live view — so a pill that reached
// for the machine, the readout or the recognizer could not even mount here.
function mountPillLayer(options: PillOptions): {
  open: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
  clearToast: ReturnType<typeof vi.fn>
} {
  const open = vi.fn()
  const exit = vi.fn()
  const clearToast = vi.fn()
  const live: MobileVoiceModeLive = {
    view: options.view,
    owner: options.owner === undefined ? OWNER : options.owner,
    entryAvailable: true
  }
  const host: MobileVoiceModeHost = {
    start: vi.fn(),
    exit,
    tapPending: vi.fn(),
    stopSpeaking: vi.fn(),
    attachScreen: vi.fn(() => () => {}),
    bindChat: vi.fn(() => () => {}),
    refresh: vi.fn(),
    open,
    subscribe: () => () => {},
    getLive: () => live
  }
  const pill: MobileVoiceModePill = {
    away: options.away ?? true,
    toast: options.toast ?? null,
    clearToast
  }
  act(() => {
    renderer = create(
      createElement(
        MobileVoiceModeHostContext.Provider,
        { value: host },
        createElement(
          MobileVoiceModePillContext.Provider,
          { value: pill },
          createElement(MobileVoiceModePillLayer)
        )
      )
    )
  })
  return { open, exit, clearToast }
}

describe('MobileVoiceModePill', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    unmountRendered()
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('labels each running route, and renders nothing on idle or closed', () => {
    const cases: [VoiceLoopRoute, string][] = [
      ['listening', 'Listening…'],
      ['thinking', 'Thinking…'],
      ['speaking', 'Speaking…']
    ]
    for (const [route, label] of cases) {
      unmountRendered()
      mountPillLayer({ view: loopView(route) })
      expect(textContents(renderer!.root)).toContain(label)
      expect(pressableByLabel(renderer!.root, 'Exit voice mode')).toBeDefined()
    }
    for (const route of ['idle', 'closed'] as const) {
      unmountRendered()
      mountPillLayer({ view: loopView(route) })
      expect(findAllByHostType(renderer!.root, 'Pressable')).toHaveLength(0)
      expect(findAllByHostType(renderer!.root, 'Text')).toHaveLength(0)
    }
  })

  it('stays out of the way while the chat itself shows the loop', () => {
    mountPillLayer({ view: loopView('listening'), away: false })
    expect(findAllByHostType(renderer!.root, 'Pressable')).toHaveLength(0)
    expect(findAllByHostType(renderer!.root, 'Text')).toHaveLength(0)
  })

  it('names the chat it runs on, and offers the way back to a screen reader', () => {
    mountPillLayer({ view: loopView('listening') })
    const body = pressableByLabel(renderer!.root, 'Listening… in Claude Code')
    expect(body).toBeDefined()
    expect(body?.props.accessibilityRole).toBe('button')
    expect(body?.props.accessibilityHint).toBe('Double-tap to go back to the conversation')
    expect(textContents(renderer!.root)).toContain('Claude Code')
  })

  it('falls back to the bare state when the loop has no chat title', () => {
    mountPillLayer({ view: loopView('listening'), owner: { ...OWNER, title: '' } })
    expect(pressableByLabel(renderer!.root, 'Listening…')).toBeDefined()
  })

  it('taps back into the conversation, and ✕ only exits', () => {
    const { open, exit } = mountPillLayer({ view: loopView('listening') })
    act(() => {
      pressableByLabel(renderer!.root, 'Listening… in Claude Code')?.props.onPress()
    })
    expect(open).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()

    act(() => {
      pressableByLabel(renderer!.root, 'Exit voice mode')?.props.onPress()
    })
    expect(exit).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledOnce()
  })

  it('carries the away notice as a toast until it clears', () => {
    const { clearToast } = mountPillLayer({ view: loopView('listening'), toast: SEND_FAILED })
    expect(textContents(renderer!.root)).toContain(SEND_FAILED)
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(clearToast).toHaveBeenCalledOnce()
  })

  it('keeps showing a notice after the loop it was about has closed', () => {
    mountPillLayer({ view: loopView('closed'), away: false, toast: SEND_FAILED })
    // The pill is gone with the loop; the toast still says why it left.
    expect(findAllByHostType(renderer!.root, 'Pressable')).toHaveLength(0)
    expect(textContents(renderer!.root)).toContain(SEND_FAILED)
  })
})

// ---------- The pill under the real host, driven like the page drives it ----------

function fakeDictation(): UseMobileDictationResult {
  return {
    status: 'idle',
    isStarting: false,
    isRecording: false,
    isProcessing: false,
    startStalled: false,
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture shaping; the stub exercises only the fields under test
  return {
    getState: () => 'connected',
    sendRequest: async (method: string) => {
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
          : { id: 1, ok: true, result: { tabs: answer.tabs } }
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

type ControllerOverrides = {
  client?: RpcClient | null
  sessionTabs?: readonly MobileSessionTab[]
  activeSessionTab?: MobileSessionTab | null
  /** The screen's chat lane: false is the terminal view hiding the chat overlay. */
  showNativeChat?: boolean
}

function fakeController(
  showToast: ReturnType<typeof vi.fn>,
  send: (text: string) => Promise<boolean>,
  overrides: ControllerOverrides = {}
): MobileSessionController {
  const nativeChatController = {
    setTabView: (tabId: string, view: string) => {
      seam.tabViewSets.push([tabId, view])
    },
    nativeChatVoiceSeam: {
      send,
      steer: () => Promise.resolve({ steered: false }),
      turnActive: () => seam.turnActive,
      latestReplyText: () => seam.replyText
    },
    nativeChatVoiceOwnerChat: () => OWNER_CHAT
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture shaping; the stub exercises only the fields under test
  return {
    hostId: HOST_ID,
    worktreeId: WORKTREE_ID,
    client: overrides.client ?? fakeClient(),
    showToast,
    sessionTabs: overrides.sessionTabs ?? [],
    activeSessionTab: overrides.activeSessionTab ?? null,
    showNativeChat: overrides.showNativeChat ?? true,
    nativeChatController
  } as unknown as MobileSessionController
}

type HostHarness = {
  voiceMode: () => MobileSessionVoiceMode
  view: () => VoiceLoopView
  pillTexts: () => string[]
  pillPressable: (label: string) => ReactTestInstance | undefined
  pillPressables: () => number
  showToast: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  refresh: (overrides?: ControllerOverrides) => void
  unbindScreen: () => void
  rebindScreen: () => void
  blurScreen: () => void
  focusScreen: () => void
}

// The real host with its layer mounted, and one session screen the harness stands, covers or pops.
function mountPillHost(): HostHarness {
  const showToast = vi.fn()
  const send = vi.fn(async () => true)
  const dictationHost: MobileDictationHost = {
    owner: null,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    announce: vi.fn(),
    attach: vi.fn(() => () => {}),
    refresh: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getDictation: fakeDictation,
    getIdleDictation: fakeDictation,
    getUnderway: () => false
  }
  let controller = fakeController(showToast, send)
  let held: MobileSessionVoiceMode | null = null
  let view: VoiceLoopView = loopView('idle')
  function Probe(): null {
    held = useMobileSessionVoiceMode(controller)
    return null
  }
  function Watcher(): null {
    const host = useMobileVoiceModeHost()
    view = useSyncExternalStore(host.subscribe, host.getLive).view
    return null
  }
  let current: ReactTestRenderer | null = null
  let screen: ReactElement | null = createElement(Probe)
  const providers = (): ReactElement =>
    createElement(
      MobileDictationHostContext.Provider,
      { value: dictationHost },
      createElement(
        MobileVoiceModeHostProvider,
        null,
        createElement(Watcher),
        screen,
        createElement(MobileVoiceModePillLayer)
      )
    )
  const swap = () => {
    act(() => {
      current?.update(providers())
    })
  }
  act(() => {
    current = create(providers())
  })
  renderer = current
  return {
    voiceMode: () => {
      if (held === null) {
        throw new Error('no screen mounted')
      }
      return held
    },
    view: () => view,
    pillTexts: () => textContents(current!.root),
    pillPressable: (label) => pressableByLabel(current!.root, label),
    pillPressables: () => findAllByHostType(current!.root, 'Pressable').length,
    showToast,
    send,
    refresh: (overrides = {}) => {
      controller = fakeController(showToast, send, overrides)
      screen = createElement(Probe)
      swap()
    },
    unbindScreen: () => {
      screen = null
      swap()
    },
    rebindScreen: () => {
      screen = createElement(Probe)
      swap()
    },
    // The screen stays mounted while another route covers it, so its chat is not shown.
    blurScreen: () => {
      focus.inFront = false
      swap()
    },
    focusScreen: () => {
      focus.inFront = true
      swap()
    }
  }
}

// The entry's startup rides only microtasks; drain them so the shell settles inside the act.
async function flushEntry(): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    await Promise.resolve()
  }
}

async function startLoop(harness: HostHarness): Promise<void> {
  await act(async () => {
    harness.voiceMode().start()
    await flushEntry()
  })
}

// Drive one heard utterance into a send that rejects once the chat has gone wherever the test
// moves it, so the loop's send-failed notice lands wherever that leaves the routing.
async function driveSendFailure(harness: HostHarness, goAway: () => void): Promise<void> {
  seam.read = { revision: 1, committed: 'hello', tentative: '', failure: null }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  let rejectSend: ((err: Error) => void) | null = null
  harness.send.mockImplementation(() => new Promise<boolean>((_, reject) => (rejectSend = reject)))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200 + 1500 + 100)
  })
  expect(harness.send).toHaveBeenCalledWith('hello')
  goAway()
  await act(async () => {
    rejectSend?.(new Error('the chat refused the send'))
    await flushEntry()
  })
}

describe('MobileVoiceModePillLayer under the host', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    seam.calls.length = 0
    seam.read = { revision: 0, committed: '', tentative: '', failure: null }
    seam.speechStartResult = { started: true, locale: 'en-US', reason: null }
    seam.openResult = { ok: true }
    seam.beginResult = true
    seam.turnActive = false
    seam.replyText = ''
    seam.ttsStatus = 'done'
    seam.ttsSpeakCalls.length = 0
    seam.ttsStopCalls = 0
    seam.routerPushes.length = 0
    seam.navigations.length = 0
    seam.tabViewSets.length = 0
    seam.worktreeMissing = false
    seam.sessionTabs = { tabs: [] }
    focus.inFront = true
  })

  afterEach(() => {
    unmountRendered()
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('stands only while the user is away from the conversation', async () => {
    const harness = mountPillHost()
    await startLoop(harness)
    // The chat's own overlay shows the loop; the pill stays out of the way.
    expect(harness.pillPressables()).toBe(0)

    harness.unbindScreen()
    expect(harness.pillTexts()).toContain('Listening…')

    harness.rebindScreen()
    expect(harness.pillPressables()).toBe(0)

    // The screen stands but another route covers it: the pill stands in again.
    harness.blurScreen()
    expect(harness.pillTexts()).toContain('Listening…')
    harness.focusScreen()
    expect(harness.pillPressables()).toBe(0)
  })

  it('stands while the focused screen shows its terminal instead of the chat', async () => {
    const harness = mountPillHost()
    await startLoop(harness)
    expect(harness.pillPressables()).toBe(0)

    // The user switches the chat tab to its terminal view: the chat overlay — the loop's own
    // surface included — hides while the screen stays mounted and in front.
    harness.refresh({ showNativeChat: false })
    expect(harness.pillTexts()).toContain('Listening…')

    harness.refresh({ showNativeChat: true })
    expect(harness.pillPressables()).toBe(0)
  })

  it('taps back through the standing screen, or its route when none stands', async () => {
    const leafId = crypto.randomUUID()
    const tab = terminalTab('tab-1', leafId)
    const harness = mountPillHost()
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab] })
    await startLoop(harness)
    harness.unbindScreen()
    act(() => {
      harness.pillPressable('Listening… in Tab tab-1')?.props.onPress()
    })
    expect(seam.routerPushes).toEqual([
      `/h/${HOST_ID}/session/${WORKTREE_ID}?paneKey=${encodeURIComponent(`tab-1:${leafId}`)}`
    ])

    // The screen stands covered: the tap pops back to its pane instead of pushing a second route.
    harness.rebindScreen()
    harness.blurScreen()
    act(() => {
      harness.pillPressable('Listening… in Tab tab-1')?.props.onPress()
    })
    expect(seam.routerPushes).toHaveLength(1)
    expect(seam.navigations).toHaveLength(1)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture shaping; the stub exercises only the fields under test
    const action = seam.navigations[0] as {
      type: string
      payload: { params?: { paneKey?: string } }
    }
    expect(action.type).toBe('POP_TO')
    expect(action.payload.params?.paneKey).toBe(`tab-1:${leafId}`)
    // The chat itself is what hides here — only the route covers it — so no view needs restoring.
    expect(seam.tabViewSets).toEqual([])
  })

  it('taps back into the chat lane a focused screen left for its terminal', async () => {
    const leafId = crypto.randomUUID()
    const tab = terminalTab('tab-1', leafId)
    const harness = mountPillHost()
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab] })
    await startLoop(harness)
    // The screen stays in front; only its chat lane is hidden behind the terminal view.
    harness.refresh({ activeSessionTab: tab, sessionTabs: [tab], showNativeChat: false })
    act(() => {
      harness.pillPressable('Listening… in Tab tab-1')?.props.onPress()
    })
    expect(seam.navigations).toHaveLength(1)
    expect(seam.tabViewSets).toEqual([['tab-1', 'chat']])
  })

  it('✕ ends the loop from away, releasing what it holds and touching nothing else', async () => {
    const harness = mountPillHost()
    await startLoop(harness)
    harness.unbindScreen()
    act(() => {
      harness.pillPressable('Exit voice mode')?.props.onPress()
    })
    expect(harness.view().route).toBe('closed')
    expect(seam.calls).toContain('speech.cancel')
    expect(seam.calls).toContain('capture.end')
    expect(seam.calls).toContain('screen.release')
    // Only the exit ran: no route was opened and no words were sent.
    expect(seam.routerPushes).toHaveLength(0)
    expect(seam.navigations).toHaveLength(0)
    expect(harness.send).not.toHaveBeenCalled()
    // The pill leaves with the loop.
    expect(harness.pillPressables()).toBe(0)
  })

  it('carries the loop notices as a toast while no screen stands', async () => {
    const harness = mountPillHost()
    await startLoop(harness)
    await driveSendFailure(harness, () => harness.unbindScreen())
    // The pill left with the loop; its toast still says why, wherever the user is now.
    expect(harness.pillPressables()).toBe(0)
    expect(harness.pillTexts()).toContain(SEND_FAILED)
    expect(harness.showToast).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(harness.pillTexts()).not.toContain(SEND_FAILED)
  })

  it('carries the loop notices as a toast while the focused screen hides its chat', async () => {
    const harness = mountPillHost()
    await startLoop(harness)
    // The screen stays mounted and in front; only its chat lane is hidden behind the terminal
    // view, so a toast on that screen would say nothing — the pill layer carries the notice.
    await driveSendFailure(harness, () => harness.refresh({ showNativeChat: false }))
    expect(harness.pillPressables()).toBe(0)
    expect(harness.pillTexts()).toContain(SEND_FAILED)
    expect(harness.showToast).not.toHaveBeenCalled()
  })
})

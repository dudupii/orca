import './mobile-prompt-render-mocks'
import { createElement, useRef } from 'react'
import { Pressable } from 'react-native'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatSendOutcome } from '../native-chat/composer/delivery/mobile-native-chat-send'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { MobileNativeChatTab } from '../native-chat/conversation/mobile-native-chat-eligibility'
import type { MobileNativeChatController } from '../native-chat/mobile-native-chat-controller-contract'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../../test-support/query-client-test-renderer'
import { vi } from 'vitest'
import { useMobileNativeChatController } from '../native-chat/use-mobile-native-chat-controller'
import { MobileNativeChatOverlay } from '../native-chat/MobileNativeChatOverlay'
import { MobileNativeChatAsk } from '../native-chat/input/prompts/MobileNativeChatAsk'
import type { AskAnswerSelection } from '../../../../src/shared/native-chat/input/questions/native-chat-ask-answer'
import { mobileNativeChatPromptDismissals } from '../native-chat/input/prompts/mobile-native-chat-prompt-dismissals'
import { setMobileNativeChatDraftText } from '../native-chat/composer/drafts/mobile-native-chat-draft-store'
import { MobileNativeChatDraftDestination } from '../native-chat/composer/drafts/mobile-native-chat-draft-inputs'
import type { MobileSessionVoiceMode } from '../../voice-mode/use-mobile-session-voice-mode'
import {
  mobileVoiceSessionKey,
  MobileVoiceModeHostContext,
  type MobileVoiceModeHost
} from '../../voice-mode/voice-mode-host-context'
export const visible = { value: true }
const messages: NativeChatMessage[] = []
export const session = {
  messages,
  folded: [],
  status: 'ready',
  transcriptLoading: false
}
export const structuredSession = {
  asyncQuestionSourceScope: 'journal/host/session/epoch',
  session,
  isWorking: false,
  turnId: null,
  turnIndicator: null,
  workingStartedAt: null,
  settledTurns: null,
  turnJournal: null,
  permission: null,
  question: null,
  queued: { cards: [] },
  respondPermission: vi.fn(async () => true),
  respondQuestion: vi.fn(async () => true),
  cancelPrompt: vi.fn(async () => true),
  sendWithOutcome: vi.fn<() => Promise<MobileNativeChatSendOutcome>>(async () => 'accepted'),
  cancel: vi.fn(),
  setStructuredOption: vi.fn(),
  invokeStructuredOption: vi.fn()
}
const sessionCommands = { commands: undefined, refresh: vi.fn() }
vi.mock('../use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({
    isTabChatView: () => visible.value,
    setTabView: (_tabId: string, view: string) =>
      Object.assign(visible, { value: view === 'chat' }),
    toggleTabChatView: () => Object.assign(visible, { value: !visible.value })
  })
}))
// The chat's per-connection CI setting read isn't a prompt write; these tests count only those.
vi.mock('../native-chat/preferences/use-mobile-native-chat-ci-result-lines', () => ({
  useMobileNativeChatCiResultLines: () => false
}))
vi.mock('../native-chat/conversation/use-mobile-native-chat-session-lane', () => ({
  useMobileNativeChatSessionLane: () => ({ session, structuredSession, sessionCommands }),
  // No voice loop runs in these harnesses; the chat's own visibility carries the lane.
  useNativeChatLaneAttached: () => true
}))
setMobileNativeChatDraftText('draft', 'ordinary message')
vi.mock('../native-chat/composer/drafts/use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: () => ({
    draftKey: 'draft',
    setComposerText: vi.fn(),
    getComposerEditGeneration: () => 0,
    appendComposerText: () => true,
    pending: [],
    imagePreviewsByMessageId: {},
    captureSendOrigin: (text: string) => ({
      draftKey: 'draft',
      normalizedText: text,
      draftDestination: new MobileNativeChatDraftDestination('draft'),
      draftEditGeneration: 0,
      pendingKey: null,
      boundary: {},
      sentAt: 0
    }),
    readSeededLaunchDraft: () => null,
    readSeededLaunchDraftSeed: () => null,
    clearDraftForSend: vi.fn(),
    restoreRejectedDraft: vi.fn(),
    acceptSend: vi.fn(),
    holdUnconfirmedSend: vi.fn()
  })
}))
vi.mock(
  '../native-chat/input/session-options/use-mobile-native-chat-session-option-controller',
  () => ({
    useMobileNativeChatSessionOptionController: () => ({
      nativeChatSessionOptions: undefined,
      recordCommand: vi.fn()
    })
  })
)
vi.mock('../native-chat/composer/attachments/use-mobile-native-chat-file-search', () => ({
  useMobileNativeChatFileSearch: () => ({ nativeChatFilePaths: [], loadNativeChatFiles: vi.fn() })
}))
vi.mock('../native-chat/composer/menus/use-mobile-native-chat-composer-tray', () => ({
  NO_COMPOSER_TRAY: {},
  useMobileNativeChatComposerTray: () => ({})
}))

let tree: ReactTestRenderer | null = null
let controller: MobileNativeChatController
let lastProps: HarnessProps | null = null
export const handleRef = { current: 'term-1' }
export const sendError = vi.fn()
const resolved = vi.fn()
let client: RpcClient

export function response(
  accepted = true,
  outcome: 'accepted' | 'refused' | 'unverifiable' | 'legacy' = accepted ? 'accepted' : 'refused'
): RpcResponse {
  return {
    id: 'send',
    ok: true,
    result: {
      send: { accepted, ...(outcome === 'legacy' ? {} : { writeSettlement: { outcome } }) }
    },
    _meta: { runtimeId: 'r' }
  }
}
export const baseTab = {
  type: 'terminal',
  launchAgent: 'claude',
  agentStatus: {
    agentType: 'claude',
    state: 'waiting',
    prompt: '',
    updatedAt: 10,
    paneKey: 'tab-1:leaf-1',
    stateHistory: [],
    stateStartedAt: 10,
    providerSession: { id: 'session-1', key: 'session_id' }
  }
} satisfies MobileNativeChatTab
export const permissionTab = {
  ...baseTab,
  agentStatus: {
    ...baseTab.agentStatus,
    interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'echo yes' } })
  }
} satisfies MobileNativeChatTab
// Voice mode stays idle in these harnesses; its overlay renders nothing and the mic never enters it.
const idleVoiceMode: MobileSessionVoiceMode = {
  view: { route: 'idle', transcript: '', pending: null, reply: null },
  entryAvailable: false,
  start: () => {},
  tapPending: () => {},
  stopSpeaking: () => {},
  exit: () => {}
}
type HarnessProps = {
  tab?: MobileNativeChatTab
  tabId?: string
  connState?: ConnectionState
  hostId?: string
  /** The pane the page's voice loop runs on, when one does; null keeps the harness hostless. */
  voiceOwnerPane?: string | null
}
// A host whose loop runs on the given pane of this harness's session: enough of an owner for the
// chat resolution to pin the pane's chat while the session's active tab moves off it.
function voiceHostFor(paneKey: string): MobileVoiceModeHost {
  const live = {
    view: idleVoiceMode.view,
    owner: {
      instance: {},
      sessionKey: mobileVoiceSessionKey('host', undefined, 'folder:work'),
      client: null,
      worktreeId: 'folder:work',
      href: '',
      paneKey,
      title: ''
    },
    entryAvailable: false
  }
  return {
    start: () => {},
    exit: () => {},
    tapPending: () => {},
    stopSpeaking: () => {},
    attachScreen: () => () => {},
    bindChat: () => () => {},
    subscribe: () => () => {},
    getLive: () => live,
    open: () => {}
  }
}
// The controller runs below any voice host provider, so its chat resolution sees the loop's pane.
function ChatScreen(props: HarnessProps) {
  const { tab = baseTab, tabId = 'tab-1', connState = 'connected', hostId = 'host' } = props
  const current = useMobileNativeChatController({
    client,
    pairedHostClient: client,
    hostId,
    worktreeId: 'folder:work',
    activeSessionTab: tab,
    activeSessionTabId: tabId,
    activeHandleRef: handleRef,
    deviceTokenRef: { current: null },
    nativeChatTranscriptIsLocalReadable: true,
    nativeChatInputLeaseReady: true,
    connState,
    onSendError: sendError,
    onSendResolved: resolved
  })
  captureRenderedController(current)
  return createElement(MobileNativeChatOverlay, {
    controller: current,
    worktreePath: null,
    connState,
    onOpenFile: vi.fn(),
    onRunInTerminal: vi.fn(),
    images: {
      sendNativeChat: (text: string) => controller.handleNativeChatSend(text),
      attachments: [],
      isAttaching: false,
      attachImage: async () => {},
      removeAttachment: () => {}
    },
    onMicPress: vi.fn(),
    voiceMode: idleVoiceMode,
    onMicPressOut: vi.fn(),
    onMicPressIn: vi.fn(),
    micActive: false,
    micStarting: false,
    micProcessing: false,
    dictationMode: 'toggle',
    inputLockReason: connState === 'connected' ? null : 'disconnected',
    sendErrorMessage: null,
    onClearSendError: vi.fn(),
    sendSurfaceId: 'surface',
    sessionId: null,
    getSendCompletionGeneration: () => 0,
    keyboardInset: 0,
    hostName: null
  })
}

function Harness(props: HarnessProps) {
  const { voiceOwnerPane = null } = props
  // The stub stays one object while the pane stands — the store's snapshot must be stable — and is
  // rebuilt when the pane moves or the loop ends.
  const voiceHostRef = useRef<{ paneKey: string | null; host: MobileVoiceModeHost | null }>({
    paneKey: null,
    host: null
  })
  if (voiceOwnerPane !== voiceHostRef.current.paneKey) {
    voiceHostRef.current = {
      paneKey: voiceOwnerPane,
      host: voiceOwnerPane === null ? null : voiceHostFor(voiceOwnerPane)
    }
  }
  const screen = createElement(ChatScreen, props)
  return voiceHostRef.current.host === null
    ? screen
    : createElement(
        MobileVoiceModeHostContext.Provider,
        { value: voiceHostRef.current.host },
        screen
      )
}
export async function render(props: HarnessProps = lastProps ?? {}) {
  lastProps = props
  await act(async () => {
    const element = createElement(Harness, props)
    if (tree) {
      tree.update(element)
    } else {
      tree = createWithQueryClient(element)
    }
  })
}
export function sendButton() {
  return getTree().root.findByProps({ accessibilityLabel: 'Send message' })
}
export function permissionAction(index = 1) {
  return getTree()
    .root.findByProps({ testID: 'native-chat-approval-actions' })
    .findAllByType(Pressable)[index]
}
export async function unmount() {
  await act(async () => tree?.unmount())
  tree = null
}
export function reset(rpcClient: RpcClient) {
  client = rpcClient
  visible.value = true
  handleRef.current = 'term-1'
  lastProps = null
  session.messages = []
  structuredSession.asyncQuestionSourceScope = 'journal/host/session/epoch'
  structuredSession.sendWithOutcome.mockReset().mockResolvedValue('accepted')
  sendError.mockReset()
  resolved.mockReset()
  mobileNativeChatPromptDismissals.clearForTests()
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) =>
    setTimeout(() => callback(0), 0)
  )
}
export function getTree(): ReactTestRenderer {
  if (!tree) {
    throw new Error('not rendered')
  }
  return tree
}
function captureRenderedController(value: MobileNativeChatController): void {
  controller = value
}
export function getController(): MobileNativeChatController {
  return controller
}
export function askCancel(): Promise<boolean> {
  return getTree().root.findByType(MobileNativeChatAsk).props.onCancel()
}
export function askCollapse(): void {
  getTree().root.findByType(MobileNativeChatAsk).props.onCollapse()
}
export function askAnswer(selections: AskAnswerSelection[]): Promise<boolean> {
  return getTree().root.findByType(MobileNativeChatAsk).props.onAnswer(selections)
}

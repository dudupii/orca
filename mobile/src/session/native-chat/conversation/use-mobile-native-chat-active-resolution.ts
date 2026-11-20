import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../../../src/shared/native-chat/transcript/messages/native-chat-transcript-retention'
import {
  resolveMobileNativeChat,
  type MobileNativeChatResolution,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import { mobileSessionTabPaneKey } from '../../tabs/notification-pane-tab'
import { useMobileVoiceModeOwnerPane } from '../../../voice-mode/voice-mode-host-context'
import {
  useMobileSessionViewMode,
  type MobileSessionViewModeController
} from '../../use-mobile-session-view-mode'

export function useMobileNativeChatActiveResolution(args: {
  hostId: string
  worktreeId: string
  activeSessionTab: MobileNativeChatTab | null
  activeSessionTabId: string | null
  activeHandleRef: MutableRefObject<string | null>
  nativeChatTranscriptIsLocalReadable: boolean
}): {
  sessionViewReady: boolean
  isTabChatView: (tabId: string) => boolean
  setTabView: MobileSessionViewModeController['setTabView']
  toggleTabChatView: (tabId: string) => void
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  activeChatAgent: string | null
  /** False when only memory names the agent; chat writes stay locked. */
  activeChatAgentConfirmed: boolean
  activeChatAgentRef: MutableRefObject<string | null>
  activeChatSessionId: string | null
  activeChatStructured: boolean
  activeChatResolution: ReturnType<typeof resolveMobileNativeChat>
  nativeChatStatus: MobileNativeChatTab['agentStatus'] | null
  sourceIdentity: string
  streamIdentity: string
} {
  const {
    activeHandleRef,
    activeSessionTab,
    activeSessionTabId,
    hostId,
    nativeChatTranscriptIsLocalReadable,
    worktreeId
  } = args
  const {
    ready: sessionViewReady,
    isTabChatView,
    setTabView,
    toggleTabChatView
  } = useMobileSessionViewMode({ hostId, worktreeId })
  const tabWantsChat =
    activeSessionTab?.type === 'agent-session' ||
    (activeSessionTabId ? isTabChatView(activeSessionTabId) : false)
  const liveChatResolution =
    activeSessionTab && activeSessionTabId && tabWantsChat
      ? resolveMobileNativeChat(activeSessionTab, nativeChatTranscriptIsLocalReadable)
      : null
  // The voice loop's pane, when the page's loop runs on this session: its chat keeps standing while
  // the session's active tab moves off it, so the loop's lane and sends keep their chat. The pane's
  // own live chat is remembered while it stands, and serves until the loop ends on that pane.
  const voicePaneKey = useMobileVoiceModeOwnerPane({ hostId, worktreeId })
  const heldVoiceChatRef = useRef<{
    paneKey: string
    tab: MobileNativeChatTab
    resolution: MobileNativeChatResolution
  } | null>(null)
  useLayoutEffect(() => {
    if (
      voicePaneKey !== null &&
      liveChatResolution !== null &&
      activeSessionTab !== null &&
      mobileSessionTabPaneKey(activeSessionTab) === voicePaneKey
    ) {
      heldVoiceChatRef.current = {
        paneKey: voicePaneKey,
        tab: activeSessionTab,
        resolution: liveChatResolution
      }
    }
  })
  const heldVoiceChat =
    voicePaneKey !== null && liveChatResolution === null ? heldVoiceChatRef.current : null
  const pinnedVoiceChat =
    heldVoiceChat !== null && heldVoiceChat.paneKey === voicePaneKey ? heldVoiceChat : null
  const activeChatResolution = liveChatResolution ?? pinnedVoiceChat?.resolution ?? null
  const showNativeChat = liveChatResolution != null
  const showNativeChatRef = useRef(showNativeChat)
  const activeChatAgent = activeChatResolution?.agent ?? null
  const activeChatAgentRef = useRef<string | null>(activeChatAgent)

  useLayoutEffect(() => {
    showNativeChatRef.current = showNativeChat
    activeChatAgentRef.current = activeChatAgent
  }, [activeChatAgent, showNativeChat])

  const activeChatSessionId = activeChatResolution?.sessionId ?? null
  const activeChatStructured =
    activeChatResolution != null &&
    (liveChatResolution !== null
      ? activeSessionTab?.type === 'agent-session'
      : pinnedVoiceChat?.tab.type === 'agent-session')
  const activeTabStatus = (liveChatResolution !== null ? activeSessionTab : pinnedVoiceChat?.tab)
    ?.agentStatus
  const nativeChatStatus = activeChatResolution && !activeChatStructured ? activeTabStatus : null
  const routeKey = `${hostId}\0${worktreeId}\0${activeSessionTabId ?? ''}`
  const streamIdentity = `${routeKey}\0${activeChatSessionId ?? ''}\0${activeHandleRef.current ?? ''}`

  return {
    sessionViewReady,
    isTabChatView,
    setTabView,
    toggleTabChatView,
    showNativeChat,
    showNativeChatRef,
    activeChatAgent,
    activeChatAgentConfirmed: activeChatResolution?.agentConfirmed !== false,
    activeChatAgentRef,
    activeChatSessionId,
    activeChatStructured,
    activeChatResolution,
    nativeChatStatus,
    sourceIdentity: encodeNativeChatTranscriptIdentity([hostId, worktreeId]),
    streamIdentity
  }
}

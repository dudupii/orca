import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { encodeNativeChatTranscriptIdentity } from '../../../../../src/shared/native-chat/transcript/messages/native-chat-transcript-retention'
import { resolveMobileNativeChat, type MobileNativeChatTab } from './mobile-native-chat-eligibility'
import type { MobileVoiceModeOwnerChat } from '../../../voice-mode/voice-mode-host-context'
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
  /** The chat as it stands right now, for a voice loop starting on it to capture and hold. */
  voiceOwnerChat: () => MobileVoiceModeOwnerChat | null
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
  const activeChatResolution =
    activeSessionTab && activeSessionTabId && tabWantsChat
      ? resolveMobileNativeChat(activeSessionTab, nativeChatTranscriptIsLocalReadable)
      : null
  const showNativeChat = activeChatResolution != null
  const showNativeChatRef = useRef(showNativeChat)
  const activeChatAgent = activeChatResolution?.agent ?? null
  const activeChatAgentRef = useRef<string | null>(activeChatAgent)

  useLayoutEffect(() => {
    showNativeChatRef.current = showNativeChat
    activeChatAgentRef.current = activeChatAgent
  }, [activeChatAgent, showNativeChat])

  const activeChatSessionId = activeChatResolution?.sessionId ?? null
  const activeChatStructured =
    activeChatResolution != null && activeSessionTab?.type === 'agent-session'
  const activeTabStatus = activeSessionTab?.agentStatus
  const nativeChatStatus = activeChatResolution && !activeChatStructured ? activeTabStatus : null
  const routeKey = `${hostId}\0${worktreeId}\0${activeSessionTabId ?? ''}`
  const streamIdentity = `${routeKey}\0${activeChatSessionId ?? ''}\0${activeHandleRef.current ?? ''}`

  // What a loop starting now captures: the chat the mic was pressed on, with the terminal handle it
  // types into — read once, at the press, and never again. The loop rides this snapshot for its
  // whole life; the resolution above keeps following the live tab for everything the user sees.
  const voiceOwnerChat = (): MobileVoiceModeOwnerChat | null => {
    if (activeChatResolution === null) {
      return null
    }
    return {
      structured: activeChatStructured,
      agent: activeChatResolution.agent,
      sessionId: activeChatResolution.sessionId,
      transcriptPath: activeChatResolution.transcriptPath,
      agentConfirmed: activeChatResolution.agentConfirmed,
      sessionLive: activeChatResolution.sessionLive,
      handle: activeHandleRef.current,
      tabId: activeSessionTabId,
      launchDraft: activeSessionTab?.launchDraft ?? null,
      launchDraftCreatedAt: activeSessionTab?.launchDraftCreatedAt ?? null
    }
  }

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
    voiceOwnerChat,
    sourceIdentity: encodeNativeChatTranscriptIdentity([hostId, worktreeId]),
    streamIdentity
  }
}

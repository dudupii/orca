import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react'
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
  /** The handle the chat's terminal writes ride: pinned to the loop's pane while it holds the chat. */
  chatHandleRef: MutableRefObject<string | null>
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
  // the session's active tab moves off it, so the loop's lane, identity and sends keep their chat.
  // The pane's own live chat is remembered while it stands, and serves until the loop ends on that
  // pane — wherever the active tab has moved, onto another pane's chat included.
  const voicePaneKey = useMobileVoiceModeOwnerPane({ hostId, worktreeId })
  const heldVoiceChatRef = useRef<{
    paneKey: string
    tab: MobileNativeChatTab
    resolution: MobileNativeChatResolution
    handle: string | null
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
        resolution: liveChatResolution,
        handle: activeHandleRef.current
      }
    }
  })
  const heldVoiceChat =
    voicePaneKey !== null && mobileSessionTabPaneKey(activeSessionTab) !== voicePaneKey
      ? heldVoiceChatRef.current
      : null
  const pinnedVoiceChat =
    heldVoiceChat !== null && heldVoiceChat.paneKey === voicePaneKey ? heldVoiceChat : null
  // The held chat outranks whatever chat the moved-to tab shows live: the loop's lane, identity and
  // sends ride the pane it started on, and the visible tab's own chat drives only its visibility.
  const activeChatResolution = pinnedVoiceChat?.resolution ?? liveChatResolution ?? null
  const showNativeChat = liveChatResolution != null
  const showNativeChatRef = useRef(showNativeChat)
  const activeChatAgent = activeChatResolution?.agent ?? null
  const activeChatAgentRef = useRef<string | null>(activeChatAgent)

  useLayoutEffect(() => {
    pinnedVoiceChatRef.current = pinnedVoiceChat
    showNativeChatRef.current = showNativeChat
    activeChatAgentRef.current = activeChatAgent
  })

  const activeChatSessionId = activeChatResolution?.sessionId ?? null
  const activeChatStructured =
    activeChatResolution != null &&
    (pinnedVoiceChat !== null
      ? pinnedVoiceChat.tab.type === 'agent-session'
      : activeSessionTab?.type === 'agent-session')
  const activeTabStatus = (pinnedVoiceChat !== null ? pinnedVoiceChat.tab : activeSessionTab)
    ?.agentStatus
  const nativeChatStatus = activeChatResolution && !activeChatStructured ? activeTabStatus : null
  const routeKey = `${hostId}\0${worktreeId}\0${activeSessionTabId ?? ''}`
  // The chat's terminal handle: the pane's remembered one while the loop holds its chat and the
  // live tab is elsewhere, else the live active handle. The chat's writes read it through the ref,
  // so a handle change on the newly active tab cannot retarget them into that tab's terminal.
  const pinnedVoiceChatRef = useRef(pinnedVoiceChat)
  const chatHandleRef = useMemo<MutableRefObject<string | null>>(
    () => ({
      get current() {
        return pinnedVoiceChatRef.current?.handle ?? activeHandleRef.current
      },
      set current(value: string | null) {
        activeHandleRef.current = value
      }
    }),
    [activeHandleRef]
  )
  const chatHandle = pinnedVoiceChat !== null ? pinnedVoiceChat.handle : activeHandleRef.current
  const streamIdentity = `${routeKey}\0${activeChatSessionId ?? ''}\0${chatHandle ?? ''}`

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
    chatHandleRef,
    sourceIdentity: encodeNativeChatTranscriptIdentity([hostId, worktreeId]),
    streamIdentity
  }
}

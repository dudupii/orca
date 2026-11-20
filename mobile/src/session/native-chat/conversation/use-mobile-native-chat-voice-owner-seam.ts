import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { AgentStatusEntry } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import { resolveVoiceModeReplyText } from '../../../voice-mode/voice-reply-source'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import {
  useMobileVoiceModeOwnerChat,
  type MobileVoiceModeChatSeam
} from '../../../voice-mode/voice-mode-host-context'
import type { StructuredAgentSessionHostSupport } from '../agent-session/mobile-structured-agent-session-host-support'
import { useMobileNativeChatSessionLane } from './use-mobile-native-chat-session-lane'
import { useMobileNativeChatDrafts } from '../composer/drafts/use-mobile-native-chat-drafts'
import { useMobileStructuredNativeChatSendBridge } from '../composer/delivery/use-mobile-structured-native-chat-send-bridge'
import { useMobileNativeChatMessageSend } from '../transcript/sending/use-mobile-native-chat-message-send'
import { useMobileNativeChatTerminalTurn } from '../transcript/ingestion/use-mobile-native-chat-terminal-turn'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import type { MobileNativeChatSendErrorReporter } from '../composer/delivery/use-mobile-native-chat-send-error'

// The tab rows this seam reads for its captured turn: the owner tab's id, its kind, its live status.
export type MobileVoiceOwnerSeamTab = {
  readonly id: string
  readonly type: string
  readonly agentStatus?: AgentStatusEntry | null
}

/**
 * The captured chat's own seam, mounted while the page's voice loop runs on this session: the
 * identity the loop froze at its start drives a lane, drafts and send verbs of their own, so its
 * sends, steers and turn-following keep working wherever the session's active tab has since
 * moved. Nothing visible resolves through here — the controller follows the live chat exactly as
 * before voice mode, and this seam changes neither what it shows nor where it writes.
 */
export function useMobileNativeChatVoiceOwnerSeam(args: {
  client: RpcClient | null
  pairedHostClient: RpcClient | null
  hostId: string
  worktreeId: string
  connState: ConnectionState
  sourceIdentity: string
  hostSupport: StructuredAgentSessionHostSupport | null
  deviceTokenRef: MutableRefObject<string | null>
  sessionTabs: readonly MobileVoiceOwnerSeamTab[]
  onSendError: MobileNativeChatSendErrorReporter
}): MobileVoiceModeChatSeam | null {
  const {
    client,
    pairedHostClient,
    hostId,
    worktreeId,
    connState,
    sourceIdentity,
    hostSupport,
    deviceTokenRef,
    sessionTabs,
    onSendError
  } = args
  const ownerChat = useMobileVoiceModeOwnerChat({ hostId, worktreeId })
  const structured = ownerChat?.structured ?? false
  // The capture is frozen for the loop's life; flattening it per render keeps the lane's shape.
  const resolution = ownerChat
    ? {
        agent: ownerChat.agent,
        sessionId: ownerChat.sessionId,
        transcriptPath: ownerChat.transcriptPath,
        agentConfirmed: ownerChat.agentConfirmed,
        sessionLive: ownerChat.sessionLive
      }
    : null

  // The send verbs want the captured identity as refs; the capture never moves, so syncing on it
  // suffices — the live tab's handle is nothing of this seam's.
  const handleRef = useRef<string | null>(ownerChat?.handle ?? null)
  const agentRef = useRef<string | null>(ownerChat?.agent ?? null)
  useLayoutEffect(() => {
    handleRef.current = ownerChat?.handle ?? null
    agentRef.current = ownerChat?.agent ?? null
  }, [ownerChat])

  // Fixed hook order mounts the lane before drafts, as the controller's own does.
  const appendComposerTextRef = useRef<(text: string) => boolean>(() => false)
  const nativeChatLane = useMobileNativeChatSessionLane({
    client,
    pairedHostClient,
    hostId,
    composerScopeKey: mobileNativeChatScopeKey(hostId, worktreeId, ownerChat?.tabId ?? null),
    structured,
    resolution,
    sourceIdentity,
    hostSupport,
    appendComposerTextRef,
    // The captured chat's lane stays subscribed for the whole loop, hidden or not; without a loop
    // on this session the starved identity subscribes to nothing.
    enabled: ownerChat != null,
    connState,
    onSendError
  })
  const { structuredSession, session: ownerSession } = nativeChatLane
  const {
    pending: ownerPending,
    captureSendOrigin,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  } = useMobileNativeChatDrafts({
    hostId,
    worktreeId,
    tabId: ownerChat?.tabId ?? null,
    sessionId: resolution?.sessionId ?? null,
    messages: ownerSession.messages,
    launchDraft: ownerChat?.launchDraft ?? null,
    launchDraftCreatedAt: ownerChat?.launchDraftCreatedAt ?? null,
    chatActive: ownerChat != null,
    transcriptLoading: ownerSession.transcriptLoading,
    transcriptSettled: ownerSession.status === 'ready',
    connected: connState === 'connected',
    onSendError
  })

  const commandSendRef = useRef<(command: string) => void>(() => {})
  const { send: sendOwnerTerminal, sendWithOutcome: sendOwnerTerminalWithOutcome } =
    useMobileNativeChatMessageSend({
      client,
      enabled:
        ownerChat != null && !structured && connState === 'connected' && ownerChat.agentConfirmed,
      handleRef,
      deviceTokenRef,
      agentRef,
      commandSendRef,
      captureSendOrigin,
      readSeededLaunchDraftSeed,
      clearDraftForSend,
      restoreRejectedDraft,
      acceptSend,
      holdUnconfirmedSend,
      onSendError
    })

  const structuredOwnerSend = useMobileStructuredNativeChatSendBridge({
    agent: structured ? resolution?.agent : undefined,
    sessionCommands: nativeChatLane.sessionCommands.commands,
    sendStructured: structuredSession.sendWithOutcome,
    captureSendOrigin,
    clearDraftForSend,
    restoreRejectedDraft,
    holdUnconfirmed: structuredSession.holdUnconfirmed,
    onSendError
  })

  // The owner tab's own status row drives the captured turn — looked up by the captured tab id, so
  // the active tab's row cannot answer for a chat it never was.
  const ownerTabStatus =
    ownerChat?.tabId != null
      ? (sessionTabs.find((tab) => tab.id === ownerChat.tabId && tab.type === 'terminal')
          ?.agentStatus ?? null)
      : null
  // The loop never stops a turn through its seam — a mid-turn utterance steers it instead.
  const stopOwnerTurn = useCallback(async () => false, [])
  const ownerTurn = useMobileNativeChatTerminalTurn({
    status: ownerTabStatus,
    resolution,
    session: structured ? null : ownerSession,
    latestPendingId: ownerPending.at(-1)?.id ?? null,
    pending: ownerPending,
    hasPromptCard: false,
    scopeKey: `voice-owner\0${hostId}\0${worktreeId}\0${ownerChat?.tabId ?? ''}`,
    stop: stopOwnerTurn
  })

  if (ownerChat === null) {
    return null
  }
  return {
    send: structured ? structuredOwnerSend.send : sendOwnerTerminal,
    // Steering rides the captured chat's send verb with the intent that reroutes the running turn.
    steer: (text) =>
      (structured ? structuredOwnerSend.sendWithOutcome : sendOwnerTerminalWithOutcome)(
        text,
        undefined,
        undefined,
        undefined,
        undefined,
        { steer: true }
      ).then((outcome) => ({ steered: outcome !== 'rejected' })),
    turnActive: () => (structured ? structuredSession.isWorking : ownerTurn.turnActive),
    // A structured chat reads its transcript; a terminal chat reads the status preview channel,
    // whose done snapshot often leads the transcript parse when the turn settles.
    latestReplyText: () =>
      resolveVoiceModeReplyText({
        structured,
        messages: ownerSession.messages,
        status: ownerTabStatus
      })
  }
}

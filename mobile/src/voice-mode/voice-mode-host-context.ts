import { createContext, useContext, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import type { VoiceLoopView } from './voice-loop-shell-contract'

// Who started the voice loop and the chat it runs on, fixed at the start: leaving the screen never moves its words.
export type MobileVoiceModeOwner = {
  // The starting screen instance, and the session it shows (a reopened screen of that session takes over its controls).
  readonly instance: object
  readonly sessionKey: string
  readonly client: RpcClient | null
  // The session's worktree, whose liveness the page's host probes while the loop runs on it.
  readonly worktreeId: string
  // The session route that opens the chat again when its screen is gone.
  readonly href: string
  // The chat tab's pane key, for a screen still in the stack to switch back to it.
  readonly paneKey: string | undefined
  // The chat tab's own id, watched for removal when no pane key names its pane.
  readonly tabId: string | undefined
  // The chat tab's title, for the pill and its toasts.
  readonly title: string
  // The chat the loop captured at its start, served by a seam of its own for the loop's whole life.
  readonly chat: MobileVoiceModeOwnerChat | null
}

// The chat identity a loop captured at its start: the owner tab's agent, session and terminal handle
// as they stood the moment the mic was pressed. Frozen for the loop's life, so a later move of the
// session's active tab — onto another pane's chat, onto another terminal — can neither redirect the
// loop's held words nor reject them against a handle they were never spoken to.
export type MobileVoiceModeOwnerChat = {
  // True when the owner tab is a structured agent session; false when it is a terminal chat.
  readonly structured: boolean
  readonly agent: string
  readonly sessionId: string | null
  readonly transcriptPath: string | null
  // False when only memory names the agent; a captured shell must not receive the loop's writes.
  readonly agentConfirmed: boolean
  readonly sessionLive: boolean
  // The terminal the owner chat typed into at start; null for a structured chat.
  readonly handle: string | null
  // The owner tab's own id: its live status row drives the captured turn, its scope keys the drafts.
  readonly tabId: string | null
  // Parked launch text the owner terminal held at start, kept so the seam's sends clear it like the chat's own do.
  readonly launchDraft?: string | null
  readonly launchDraftCreatedAt?: number | null
}

// A mounted session screen, as the voice host sees it.
export type MobileVoiceModeScreen = {
  readonly instance: object
  readonly sessionKey: string
  // True while this screen stands for the loop's chat (in front, its session's).
  readonly shown: () => boolean
  // Pop the screens above this one and show the chat tab.
  readonly bringToFront: (paneKey: string | undefined) => void
  // Where the loop's notices toast while this screen shows the chat.
  readonly toast: (message: string) => void
}

/** The chat seams the loop rides while a screen is mounted: sending, steering the running turn, its latest reply. */
export type MobileVoiceModeChatSeam = {
  readonly send: (text: string) => Promise<boolean>
  /** Reroutes the running turn with a mid-turn utterance; false reports the chat refused it. */
  readonly steer: (text: string) => Promise<{ steered: boolean }>
  readonly turnActive: () => boolean
  /** The chat's latest reply text, sampled when a turn settles. */
  readonly latestReplyText: () => string
}

// The live loop, stable across its ticks: screens read the view through subscribe, so a word heard re-renders only who shows it.
export type MobileVoiceModeLive = {
  readonly view: VoiceLoopView
  readonly owner: MobileVoiceModeOwner | null
  readonly entryAvailable: boolean
}

// The floating pill's own state, apart from the host's so a toast or a shown flip re-renders only the pill.
export type MobileVoiceModePill = {
  // True while the loop runs with its chat off screen: the pill stands in for the chat's overlay.
  readonly away: boolean
  // The notice that landed while no screen stood for the chat, shown as a toast until it clears.
  readonly toast: string | null
  readonly clearToast: () => void
}

export type MobileVoiceModeHost = {
  /** Starts the page's one loop from the chat screen that long-pressed the mic. */
  readonly start: (owner: MobileVoiceModeOwner) => void
  /** Ends the loop: the machine settles terminal and the mic and screen release. */
  readonly exit: () => void
  readonly tapPending: () => void
  readonly stopSpeaking: () => void
  /** A screen registers itself so the loop can bring its chat back to the front. */
  readonly attachScreen: (screen: MobileVoiceModeScreen) => () => void
  /** The mounted screen's chat seam, bound while it stands; the return unbinds it. */
  readonly bindChat: (binding: MobileVoiceModeChatBinding) => () => void
  /** A screen's shown() answer changed; the pill reads it on the host's render. */
  readonly refresh: () => void
  /** Brings the loop's chat back to the front, opening its session again when no screen stands. */
  readonly open: () => void
  readonly subscribe: (listener: () => void) => () => void
  /** The live loop; its identity holds until the view, owner or entry moves. */
  readonly getLive: () => MobileVoiceModeLive
}

// One mounted screen's chat seam; the last bound stands for the loop's chat. The client rides the
// binding so a rebound screen's different client re-runs the loop's speak subscription. The seam is
// the owner chat's own — every screen of the loop's session serves the same captured identity — so
// no pane matching is needed to keep a moved tab from answering for the chat it left.
export type MobileVoiceModeChatBinding = {
  readonly instance: object
  readonly sessionKey: string
  readonly client: RpcClient | null
  readonly seam: MobileVoiceModeChatSeam
}

export const MobileVoiceModeHostContext = createContext<MobileVoiceModeHost | null>(null)
export const MobileVoiceModePillContext = createContext<MobileVoiceModePill | null>(null)

export function useMobileVoiceModeHost(): MobileVoiceModeHost {
  const host = useContext(MobileVoiceModeHostContext)
  if (!host) {
    throw new Error('useMobileVoiceModeHost needs a MobileVoiceModeHostProvider')
  }
  return host
}

const NO_VOICE: MobileVoiceModeLive = {
  view: { route: 'idle', transcript: '', pending: null, reply: null },
  owner: null,
  entryAvailable: false
}
const subscribeNever = () => () => undefined

/**
 * The chat the page's voice loop captured at its start, when it runs on this session: the controller
 * mounts the captured chat's own lane on it. Null when the loop is on another session, on none, or
 * started from no chat; null without a host too, so harnesses mounting the chat controller alone see
 * no voice holding anything.
 */
export function useMobileVoiceModeOwnerChat(args: {
  hostId: string
  worktreeId: string
}): MobileVoiceModeOwnerChat | null {
  const host = useContext(MobileVoiceModeHostContext)
  const executionHost = useWorkspaceExecutionHost()
  const owner = useSyncExternalStore(
    host?.subscribe ?? subscribeNever,
    host?.getLive ?? (() => NO_VOICE)
  ).owner
  if (
    owner === null ||
    owner.sessionKey !== mobileVoiceSessionKey(args.hostId, executionHost, args.worktreeId)
  ) {
    return null
  }
  return owner.chat
}

// The session a voice loop runs on — its host, the server executing it, its worktree — as one key.
export function mobileVoiceSessionKey(
  hostId: string,
  executionHost: ExecutionHostId | undefined,
  worktreeId: string
): string {
  return JSON.stringify([hostId, executionHost ?? null, worktreeId])
}

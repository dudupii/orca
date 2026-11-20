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
  /** Brings the loop's chat back to the front, opening its session again when no screen stands. */
  readonly open: () => void
  readonly subscribe: (listener: () => void) => () => void
  /** The live loop; its identity holds until the view, owner or entry moves. */
  readonly getLive: () => MobileVoiceModeLive
}

// One mounted screen's chat seam; the last bound stands for the loop's chat. The client rides the
// binding so a rebound screen's different client re-runs the loop's speak subscription, and the pane
// key answers live so a screen whose tab moved cannot stand for a pane it no longer shows.
export type MobileVoiceModeChatBinding = {
  readonly instance: object
  readonly sessionKey: string
  readonly client: RpcClient | null
  /** The pane this screen's chat stands on now, read live through the controller. */
  readonly paneKey: () => string | undefined
  readonly seam: MobileVoiceModeChatSeam
}

export const MobileVoiceModeHostContext = createContext<MobileVoiceModeHost | null>(null)

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
 * The session the live loop runs on, or null; null without a host too, so harnesses mounting the
 * chat controller alone see no voice holding anything.
 */
export function useMobileVoiceModeOwnerSession(): string | null {
  const host = useContext(MobileVoiceModeHostContext)
  return (
    useSyncExternalStore(host?.subscribe ?? subscribeNever, host?.getLive ?? (() => NO_VOICE)).owner
      ?.sessionKey ?? null
  )
}

/**
 * The pane the page's voice loop runs on, when it runs on this session: the chat's identity stands
 * on that pane while the loop holds it, even when the session's active tab moves off it. Null when
 * the loop is on another session, on none, or started from no pane.
 */
export function useMobileVoiceModeOwnerPane(args: {
  hostId: string
  worktreeId: string
}): string | null {
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
  return owner.paneKey ?? null
}

// The session a voice loop runs on — its host, the server executing it, its worktree — as one key.
export function mobileVoiceSessionKey(
  hostId: string,
  executionHost: ExecutionHostId | undefined,
  worktreeId: string
): string {
  return JSON.stringify([hostId, executionHost ?? null, worktreeId])
}

// The lane's attach rule with voice mode in force: shown, or held attached by the page's loop on this session.
export function voiceLaneAttached(
  showNativeChat: boolean,
  voiceOwnerSession: string | null,
  sessionKey: string
): boolean {
  return showNativeChat || voiceOwnerSession === sessionKey
}

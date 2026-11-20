import type { AgentStatusEntry } from '../../../src/shared/agent-status/contracts/agent-status-types'
import { latestNativeChatReplyText } from '../../../src/shared/native-chat/native-chat-streaming'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import type { NativeChatMessage } from '../../../src/shared/native-chat/native-chat-types'

/**
 * The chat's latest reply text for the voice loop's readout: a structured chat reads its
 * transcript, a terminal chat reads the status preview channel, whose done snapshot often
 * leads the transcript parse at the moment a turn settles.
 */
export function resolveVoiceModeReplyText(args: {
  structured: boolean
  messages: readonly NativeChatMessage[]
  status: AgentStatusEntry | null | undefined
}): string {
  const { structured, messages, status } = args
  if (structured) {
    return latestNativeChatReplyText(messages)
  }
  // Tool stdout is not assistant prose; the completed-turn snapshot covers working pings that clear the live preview.
  const live =
    status?.lastAssistantMessageIsToolOutput === true ? undefined : status?.lastAssistantMessage
  return (
    speakableReply(live, status?.prompt) ||
    speakableReply(status?.lastCompletedAssistantMessage, status?.prompt)
  )
}

// Hooks can echo the user prompt into preview fields and replies can mount visuals; read out neither.
function speakableReply(text: string | undefined, prompt: string | undefined): string {
  const trimmed = text?.trim()
  if (!trimmed || trimmed === prompt?.trim()) {
    return ''
  }
  return withoutNativeChatVisualDirectiveLines(trimmed).trim()
}

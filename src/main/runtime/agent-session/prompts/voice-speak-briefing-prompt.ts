/**
 * The voice briefing prompt taught to agents whose spawn found a voice-capable phone: briefings
 * over readouts, prose over lists. The appendix is per-session — it names the spawn's session id
 * and directs every `speak` call to carry it, so a briefing plays only in its own conversation.
 * One builder holds the wording for every provider's prompt carrier; the launch resolvers and
 * provider launch modules consume it here and never keep their own copy.
 */
const VOICE_SPEAK_BRIEFING_PROMPT_APPEND =
  'A paired phone is listening: the `speak` tool reads a short briefing aloud there. ' +
  'Close meaningful work with one spoken briefing - briefings over readouts, prose over lists - ' +
  'and keep the written reply for the details. Speaking is optional: skip it when there is ' +
  'nothing worth hearing aloud.'

/** The briefing wording sealed for one spawn: the shared style plus that spawn's session contract. */
export function voiceSpeakBriefingPromptAppend(sessionId: string): string {
  return (
    `${VOICE_SPEAK_BRIEFING_PROMPT_APPEND} This conversation's session id is ${sessionId}: ` +
    'pass it as the session argument on every `speak` call so the briefing plays only here.'
  )
}

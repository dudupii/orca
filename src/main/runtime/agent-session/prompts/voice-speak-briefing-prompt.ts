/**
 * The voice briefing style taught to agents whose spawn found a voice-capable phone: briefings
 * over readouts, prose over lists. One wording shared by every provider's prompt carrier — the
 * launch resolver and provider launch modules consume it here and never keep their own copy.
 */
export const VOICE_SPEAK_BRIEFING_PROMPT_APPEND =
  'A paired phone is listening: the `speak` tool reads a short briefing aloud there. ' +
  'Close meaningful work with one spoken briefing - briefings over readouts, prose over lists - ' +
  'and keep the written reply for the details. Speaking is optional: skip it when there is ' +
  'nothing worth hearing aloud.'

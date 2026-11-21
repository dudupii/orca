import * as z from 'zod'

// The page asks the phone for a short chime. One verb keeps the route within the grant ceiling.
export const BRIDGE_TONE_VERB = 'native.tone.act'

// One kind today: restore, the blip that says foreground voice mode came back. The list is pinned
// here so a newer engine cannot invent a kind a shipped page rejects.
export const BRIDGE_TONE_KINDS = ['restore'] as const

export type BridgeToneKind = (typeof BRIDGE_TONE_KINDS)[number]

export const toneParamsSchema = z.strictObject({
  kind: z.enum(BRIDGE_TONE_KINDS)
})

// Empty because a chime carries nothing back: fire-and-forget is the whole exchange, and one that
// cannot sound is silence the caller never hears about.
export const toneResultSchema = z.strictObject({})

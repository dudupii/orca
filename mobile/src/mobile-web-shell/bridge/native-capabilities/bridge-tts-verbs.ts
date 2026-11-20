import * as z from 'zod'

// Playback runs in the shell, which owns the phone's speaker; the page only asks and polls. One verb with an
// action keeps the session route within the grant ceiling; the page polls read because the bridge has no push lane.
export const BRIDGE_TTS_VERB = 'native.tts.act'

// idle: nothing claimed yet or everything settled. speaking: the utterance the latest revision claimed. The rest are settled endings.
export const BRIDGE_TTS_STATUSES = [
  'idle',
  'speaking',
  'done',
  'stopped',
  'interrupted',
  'failed'
] as const

export type BridgeTtsStatus = (typeof BRIDGE_TTS_STATUSES)[number]

// Same coarse codes the seam's failures use, kept here so a newer engine cannot invent one a shipped page rejects.
export const BRIDGE_TTS_FAILURES = ['unsupported', 'busy', 'failed'] as const

export type BridgeTtsFailure = (typeof BRIDGE_TTS_FAILURES)[number]

const localeSchema = z.string().min(1).max(35)

// speak resolves once the utterance is claimed, not once playback ends: the reply carries only the revision its ending will be read under.
const speakParamsSchema = z.strictObject({
  action: z.literal('speak'),
  text: z.string().min(1).max(16_000),
  locale: localeSchema.nullable()
})
const stopParamsSchema = z.strictObject({ action: z.literal('stop') })
const readParamsSchema = z.strictObject({ action: z.literal('read') })

export const ttsParamsSchema = z.discriminatedUnion('action', [
  speakParamsSchema,
  stopParamsSchema,
  readParamsSchema
])

export const ttsSpeakResultSchema = z.strictObject({
  revision: z.number().int().nonnegative()
})

export const ttsStopResultSchema = z.strictObject({})

// The latest claim's standing: a speak settles when its own revision reports an ending, or when a higher revision displaced it.
export const ttsReadResultSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  status: z.enum(BRIDGE_TTS_STATUSES),
  reason: z.enum(BRIDGE_TTS_FAILURES).nullable()
})

export type BridgeTtsRead = z.infer<typeof ttsReadResultSchema>

// The verb table validates the shell's reply against any action's shape; the page re-parses with the action's own.
export const ttsResultSchema = z.union([
  ttsSpeakResultSchema,
  ttsStopResultSchema,
  ttsReadResultSchema
])

import type {
  OnDeviceTtsChannel,
  OnDeviceTtsUtterance
} from '../platform/tts/on-device-tts-contract'

/** A model-authored speak broadcast as the notifications wire carries it. */
export type VoiceSpeakBroadcast = {
  readonly text: string
  readonly lang: string | null
  readonly session: string | null
}

/** The turn's authored readout; lang null leaves the phone's own language to choose. */
export type VoiceReadoutBriefing = {
  readonly text: string
  readonly lang: string | null
}

export type VoiceReadoutEnd = 'done' | 'stopped' | 'interrupted' | 'failed'

/**
 * The single owner of the speaking side: got words → started playing → playback ended or was
 * interrupted all converge here, so nothing else in voice mode touches playback. The loop's
 * machine decides what is said (briefing verbatim, else condensed reply prose, else nothing) and
 * hands this module the words; this module claims them on the phone's speaker and settles how
 * they ended. Later tickets attach without rewiring:
 * - T7 (session gating, overrides) wraps briefingArrived and reads settleBriefing — its session
 *   gate sits at the hook's subscription, dropping broadcasts that name another conversation
 *   before they reach here, so this module stays session-agnostic and the briefing choice stays
 *   between those two, never in playback.
 * - T9 (the speaking pill) reads the loop's speaking route and calls stop(); it observes and
 *   interrupts, but never owns a playback.
 */
export type VoiceReadout = {
  /** Forgets the turn's briefings; called when a new turn's send leaves. */
  readonly beginTurn: () => void
  /** The model's speak broadcast arrived mid-turn; the latest one before settle is the one spoken. */
  readonly briefingArrived: (broadcast: VoiceSpeakBroadcast) => void
  /** The turn's authored readout, null when the model wrote none this turn. */
  readonly settleBriefing: () => VoiceReadoutBriefing | null
  /** Plays one utterance and settles with how it ended; a newer play interrupts the previous. */
  readonly play: (utterance: OnDeviceTtsUtterance) => Promise<VoiceReadoutEnd>
  /** Stops the live utterance; its play settles 'stopped'. Never throws. */
  readonly stop: () => void
}

/** What createVoiceReadout plays through; null mutes playback without breaking the turn. */
export type VoiceReadoutDeps = {
  readonly playback: OnDeviceTtsChannel | null
}

import type {
  VoiceLoopRoute,
  VoiceLoopThresholds
} from '../../../src/shared/voice/voice-loop-machine'
import type { OnDeviceTone } from '../platform/tone/on-device-tone-contract'
import type { VoiceReadout } from './voice-readout-contract'

export type { VoiceLoopRoute } from '../../../src/shared/voice/voice-loop-machine'

export type VoiceLoopShellDeps = {
  readonly now: () => number
  /**
   * Arms the recognizer; busy reports another session's exclusive hold of the microphone,
   * needsDownload a language model the recognizer must download before it can arm.
   */
  readonly startSpeech: () => Promise<{
    started: boolean
    busy: boolean
    readonly needsDownload?: boolean
  }>
  readonly cancelSpeech: () => void
  readonly readSpeech: () => Promise<VoiceLoopTranscriptRead>
  /** Opens the microphone; false when permission or the device refused. */
  readonly openMic: () => Promise<boolean>
  readonly closeMic: () => void
  /** Keeps the screen on while the loop runs; released when the loop ends. */
  readonly holdScreen: () => void
  readonly releaseScreen: () => void
  /** The speaking side's single owner: the shell plays the machine's words through it and stops it on barge-in or exit. */
  readonly readout: VoiceReadout
  /** The restore chime's player; null when the page lacks the verb grant, and a restore stays silent. */
  readonly tone?: OnDeviceTone | null
  /** Read at loop start; false keeps speech from cutting playback. A tap still stops it. */
  readonly bargeIn?: boolean
  /** Read at loop start; false mutes the reply's fallback prose. An authored briefing still speaks. */
  readonly fallbackReadout?: boolean
  readonly send: (text: string) => Promise<VoiceLoopSendOutcome>
  /** Reroutes the turn the loop is running with a mid-turn utterance; false reports the chat refused it. */
  readonly steer: (text: string) => Promise<{ steered: boolean }>
  /** False while no chat seam is bound: the commit stage holds its fire and the words wait in the machine. */
  readonly chatBound?: () => boolean
  readonly responseDelayMs: () => number
  readonly onState: (view: VoiceLoopView) => void
  readonly onNotice: (notice: VoiceLoopNotice) => void
  readonly thresholds?: Partial<VoiceLoopThresholds>
  readonly readIntervalMs?: number
}

/** One poll of the recognizer: whole committed text so far plus the unstable tail. */
export type VoiceLoopTranscriptRead = {
  readonly revision: number
  readonly committed: string
  readonly tentative: string
  readonly failure: string | null
}

/** The chat's answer to one delivered utterance; the reply text renders silently in T5. */
export type VoiceLoopSendOutcome = { sent: false } | { sent: true; reply: string }

export type VoiceLoopNotice =
  | 'mic-exclusive'
  | 'mic-unavailable'
  | 'speech-needs-download'
  | 'speech-failed'
  | 'send-failed'

/** What the overlay draws: the loop's route, the live words, the revocable wait, the last reply. */
export type VoiceLoopView = {
  readonly route: VoiceLoopRoute
  readonly transcript: string
  readonly pending: string | null
  readonly reply: string | null
}

import type {
  VoiceLoopRoute,
  VoiceLoopThresholds
} from '../../../src/shared/voice/voice-loop-machine'

export type { VoiceLoopRoute } from '../../../src/shared/voice/voice-loop-machine'

export type VoiceLoopShellDeps = {
  readonly now: () => number
  /** Arms the recognizer; busy reports another session's exclusive hold of the microphone. */
  readonly startSpeech: () => Promise<{ started: boolean; busy: boolean }>
  readonly cancelSpeech: () => void
  readonly readSpeech: () => Promise<VoiceLoopTranscriptRead>
  /** Opens the microphone; false when permission or the device refused. */
  readonly openMic: () => Promise<boolean>
  readonly closeMic: () => void
  /** Keeps the screen on while the loop runs; released when the loop ends. */
  readonly holdScreen: () => void
  readonly releaseScreen: () => void
  readonly send: (text: string) => Promise<VoiceLoopSendOutcome>
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

export type VoiceLoopNotice = 'mic-exclusive' | 'mic-unavailable' | 'speech-failed' | 'send-failed'

/** What the overlay draws: the loop's route, the live words, the revocable wait, the last reply. */
export type VoiceLoopView = {
  readonly route: VoiceLoopRoute
  readonly transcript: string
  readonly pending: string | null
  readonly reply: string | null
}

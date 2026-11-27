import ExpoTwoWayAudioModule from './ExpoTwoWayAudioModule'

// On-device text-to-speech contract. iOS and Android implement these functions and events on the
// ExpoTwoWayAudio module; JS feature-detects them because a shell built before them answers 'unsupported'.
//
// One utterance at a time, keyed by utteranceId. Interruption is the seam server's contract: a new
// utterance stops the playing one, ttsStop silences everything; the engine only plays.

// Why a start failed or an utterance died. Keep them coarse: every code means the caller gives up on it.
export const TTS_FAILURE_CODES = ['unsupported', 'busy', 'failed'] as const

export type TtsFailureCode = (typeof TTS_FAILURE_CODES)[number]

// reason is set only when started is false.
export type TtsStartResult = { started: boolean; reason: TtsFailureCode | null }

export type TtsDoneEvent = { utteranceId: string }
export type TtsErrorEvent = { utteranceId: string; code: TtsFailureCode }

type TtsNativeModule = {
  // Plays the text as the utteranceId utterance, resolving once the engine took it or refused it.
  ttsSpeak?: (utteranceId: string, text: string, locale: string | null) => Promise<TtsStartResult>
  // Synchronous and never throws. Ignored with nothing playing.
  ttsStop?: () => void
}

const tts: TtsNativeModule = ExpoTwoWayAudioModule

// A shell from before this contract lacks every function; partial builds are treated the same way.
export function hasNativeTts(): boolean {
  return typeof tts.ttsSpeak === 'function' && typeof tts.ttsStop === 'function'
}

export async function ttsSpeak(
  utteranceId: string,
  text: string,
  locale: string | null
): Promise<TtsStartResult> {
  if (!hasNativeTts() || !tts.ttsSpeak) {
    return { started: false, reason: 'unsupported' }
  }
  return tts.ttsSpeak(utteranceId, text, locale)
}

export function ttsStop(): void {
  tts.ttsStop?.()
}

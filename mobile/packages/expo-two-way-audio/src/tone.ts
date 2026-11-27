import ExpoTwoWayAudioModule from './ExpoTwoWayAudioModule'

// On-device chime contract. iOS and Android implement tonePlay on the ExpoTwoWayAudio module; JS
// feature-detects it because a shell built before it stays silent.
//
// Fire-and-forget: a chime that cannot play is silence, never an error the caller must handle.
// The engine plays on the communication audio path so the open microphone's echo canceler
// subtracts it.

// One kind today: restore, the blip that says foreground voice mode came back.
export const TONE_KINDS = ['restore'] as const

export type ToneKind = (typeof TONE_KINDS)[number]

type ToneNativeModule = {
  // Synchronous and never throws; a kind this build does not know is ignored.
  tonePlay?: (kind: string) => void
}

const tone: ToneNativeModule = ExpoTwoWayAudioModule

// A shell from before this contract lacks the function; partial builds are treated the same way.
export function hasNativeTone(): boolean {
  return typeof tone.tonePlay === 'function'
}

export function tonePlay(kind: ToneKind): void {
  tone.tonePlay?.(kind)
}

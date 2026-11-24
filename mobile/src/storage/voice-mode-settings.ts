import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from './mirrored-storage-keys'

// How long a finalized voice-mode utterance waits before it sends; a tap inside the window cancels it.
const VOICE_MODE_RESPONSE_DELAY_KEY = 'orca:voiceModeResponseDelaySeconds'
// Whether speech during playback stops it, and whether a reply without a briefing is read aloud.
const VOICE_MODE_BARGE_IN_KEY = 'orca:voiceModeBargeIn'
const VOICE_MODE_FALLBACK_READOUT_KEY = 'orca:voiceModeFallbackReadout'

export const VOICE_MODE_RESPONSE_DELAY_MIN_SECONDS = 0
export const VOICE_MODE_RESPONSE_DELAY_MAX_SECONDS = 3
export const VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS = 1.5

export const VOICE_MODE_BARGE_IN_DEFAULT = true
export const VOICE_MODE_FALLBACK_READOUT_DEFAULT = true

/** The saved delay held to its 0–3s range; anything unreadable (missing, corrupt, non-finite) is the default. */
export function clampVoiceModeResponseDelaySeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS
  }
  return Math.min(
    VOICE_MODE_RESPONSE_DELAY_MAX_SECONDS,
    Math.max(VOICE_MODE_RESPONSE_DELAY_MIN_SECONDS, seconds)
  )
}

/** True only for a stored boolean; anything else (missing, corrupt) is the default, never a guess. */
function readStoredBoolean(raw: string | null, fallback: boolean): boolean {
  return raw === 'true' ? true : raw === 'false' ? false : fallback
}

// The loop reads these in the page bundle, whose storage is the app's over the allowlist, while the
// native settings screen writes them in the shell's. Read storage on every load — a module cache
// here could never see a save the other bundle made — and save through the mirror, so a page that
// is already loaded is told (terminal settings follow this same shape).

export async function loadVoiceModeResponseDelaySeconds(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(VOICE_MODE_RESPONSE_DELAY_KEY)
    return raw === null
      ? VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS
      : clampVoiceModeResponseDelaySeconds(Number(raw))
  } catch {
    return VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS
  }
}

export async function saveVoiceModeResponseDelaySeconds(seconds: number): Promise<void> {
  await persistMirrored(
    VOICE_MODE_RESPONSE_DELAY_KEY,
    String(clampVoiceModeResponseDelaySeconds(seconds))
  )
}

export async function loadVoiceModeBargeIn(): Promise<boolean> {
  try {
    return readStoredBoolean(
      await AsyncStorage.getItem(VOICE_MODE_BARGE_IN_KEY),
      VOICE_MODE_BARGE_IN_DEFAULT
    )
  } catch {
    return VOICE_MODE_BARGE_IN_DEFAULT
  }
}

export async function saveVoiceModeBargeIn(bargeIn: boolean): Promise<void> {
  await persistMirrored(VOICE_MODE_BARGE_IN_KEY, String(bargeIn))
}

export async function loadVoiceModeFallbackReadout(): Promise<boolean> {
  try {
    return readStoredBoolean(
      await AsyncStorage.getItem(VOICE_MODE_FALLBACK_READOUT_KEY),
      VOICE_MODE_FALLBACK_READOUT_DEFAULT
    )
  } catch {
    return VOICE_MODE_FALLBACK_READOUT_DEFAULT
  }
}

export async function saveVoiceModeFallbackReadout(fallback: boolean): Promise<void> {
  await persistMirrored(VOICE_MODE_FALLBACK_READOUT_KEY, String(fallback))
}

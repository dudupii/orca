import AsyncStorage from '@react-native-async-storage/async-storage'

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

// The voice loop reads this before each utterance finalizes; only this module writes it, so keep it in memory once read.
let cached: number | null = null

export async function loadVoiceModeResponseDelaySeconds(): Promise<number> {
  if (cached !== null) {
    return cached
  }
  try {
    const raw = await AsyncStorage.getItem(VOICE_MODE_RESPONSE_DELAY_KEY)
    // A save during the read wins over what the read found.
    const delay =
      raw === null
        ? VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS
        : clampVoiceModeResponseDelaySeconds(Number(raw))
    cached ??= delay
    return delay
  } catch {
    return VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS
  }
}

export async function saveVoiceModeResponseDelaySeconds(seconds: number): Promise<void> {
  const delay = clampVoiceModeResponseDelaySeconds(seconds)
  cached = delay
  await AsyncStorage.setItem(VOICE_MODE_RESPONSE_DELAY_KEY, String(delay))
}

// The speaking-side toggles ride the same cache-once-read pattern: the loop reads them at its start.
let cachedBargeIn: boolean | null = null
let cachedFallbackReadout: boolean | null = null

export async function loadVoiceModeBargeIn(): Promise<boolean> {
  if (cachedBargeIn !== null) {
    return cachedBargeIn
  }
  try {
    const bargeIn = readStoredBoolean(
      await AsyncStorage.getItem(VOICE_MODE_BARGE_IN_KEY),
      VOICE_MODE_BARGE_IN_DEFAULT
    )
    cachedBargeIn ??= bargeIn
    return bargeIn
  } catch {
    return VOICE_MODE_BARGE_IN_DEFAULT
  }
}

export async function saveVoiceModeBargeIn(bargeIn: boolean): Promise<void> {
  cachedBargeIn = bargeIn
  await AsyncStorage.setItem(VOICE_MODE_BARGE_IN_KEY, String(bargeIn))
}

export async function loadVoiceModeFallbackReadout(): Promise<boolean> {
  if (cachedFallbackReadout !== null) {
    return cachedFallbackReadout
  }
  try {
    const fallback = readStoredBoolean(
      await AsyncStorage.getItem(VOICE_MODE_FALLBACK_READOUT_KEY),
      VOICE_MODE_FALLBACK_READOUT_DEFAULT
    )
    cachedFallbackReadout ??= fallback
    return fallback
  } catch {
    return VOICE_MODE_FALLBACK_READOUT_DEFAULT
  }
}

export async function saveVoiceModeFallbackReadout(fallback: boolean): Promise<void> {
  cachedFallbackReadout = fallback
  await AsyncStorage.setItem(VOICE_MODE_FALLBACK_READOUT_KEY, String(fallback))
}

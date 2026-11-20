import AsyncStorage from '@react-native-async-storage/async-storage'

// How long a finalized voice-mode utterance waits before it sends; a tap inside the window cancels it.
const VOICE_MODE_RESPONSE_DELAY_KEY = 'orca:voiceModeResponseDelaySeconds'

export const VOICE_MODE_RESPONSE_DELAY_MIN_SECONDS = 0
export const VOICE_MODE_RESPONSE_DELAY_MAX_SECONDS = 3
export const VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS = 1.5

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

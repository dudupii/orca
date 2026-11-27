import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from './mirrored-storage-keys'

// How long a finalized voice-mode utterance waits before it sends; a tap inside the window cancels it.
const VOICE_MODE_RESPONSE_DELAY_KEY = 'orca:voiceModeResponseDelaySeconds'
// Whether speech during playback stops it, and whether a reply without a briefing is read aloud.
const VOICE_MODE_BARGE_IN_KEY = 'orca:voiceModeBargeIn'
const VOICE_MODE_FALLBACK_READOUT_KEY = 'orca:voiceModeFallbackReadout'
// The language a reply without a spoken briefing is read in; the page-storage allowlist lists the
// key among the voice-mode settings the native settings screen owns.
const VOICE_MODE_READOUT_LANGUAGE_KEY = 'orca:voiceModeReadoutLanguage'
// The stored sentinel for follow-system; no engine would accept it as a locale, so it cannot collide with a tag.
const VOICE_MODE_READOUT_LANGUAGE_SYSTEM = 'system'

export const VOICE_MODE_RESPONSE_DELAY_MIN_SECONDS = 0
export const VOICE_MODE_RESPONSE_DELAY_MAX_SECONDS = 3
export const VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS = 1.5

export const VOICE_MODE_BARGE_IN_DEFAULT = true
export const VOICE_MODE_FALLBACK_READOUT_DEFAULT = true

/**
 * The readout-language stage as storage decodes it. Automatic probes the reply's own script and
 * falls to the device's language; system hands the choice to the phone's own language; a tag
 * names one outright. The key absent is automatic, so an install that never chose reads probed.
 */
export type VoiceModeReadoutLanguage =
  | { mode: 'automatic' }
  | { mode: 'system' }
  | { mode: 'language'; tag: string }

export const VOICE_MODE_READOUT_LANGUAGE_DEFAULT: VoiceModeReadoutLanguage = { mode: 'automatic' }

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

export async function loadVoiceModeReadoutLanguage(): Promise<VoiceModeReadoutLanguage> {
  try {
    const raw = await AsyncStorage.getItem(VOICE_MODE_READOUT_LANGUAGE_KEY)
    if (raw === VOICE_MODE_READOUT_LANGUAGE_SYSTEM) {
      return { mode: 'system' }
    }
    // The same sane tag ceiling the recognition stage bounds its stored tag by; anything past it
    // is a corrupt blob, not a choice, and reads as the default.
    if (raw !== null && raw.length > 0 && raw.length <= 35) {
      return { mode: 'language', tag: raw }
    }
    return VOICE_MODE_READOUT_LANGUAGE_DEFAULT
  } catch {
    return VOICE_MODE_READOUT_LANGUAGE_DEFAULT
  }
}

export async function saveVoiceModeReadoutLanguage(
  setting: VoiceModeReadoutLanguage
): Promise<void> {
  // Automatic is the absent key, so a fresh install's default and an explicit return to it read alike.
  const stored =
    setting.mode === 'system'
      ? VOICE_MODE_READOUT_LANGUAGE_SYSTEM
      : setting.mode === 'language'
        ? setting.tag
        : null
  await persistMirrored(VOICE_MODE_READOUT_LANGUAGE_KEY, stored)
}

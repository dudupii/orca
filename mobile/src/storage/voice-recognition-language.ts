import AsyncStorage from '@react-native-async-storage/async-storage'

// The locale the recognizer is armed in; null means Follow system, the page's locale unchanged. Phone-only: the shell resolves it, so the page never reads it.
const VOICE_RECOGNITION_LANGUAGE_KEY = 'orca:voiceRecognitionLanguage'

// Where a save and an arm each happen: the settings screen writes through saveVoiceRecognitionLanguage
// (mobile/app/voice-settings.tsx -> VoiceModeSettingsSection), and the recognizer is armed by the shell's
// native.speech.act server (MobileWebShellScreen -> use-native-device-verbs -> nativeSpeechDeviceEngine's
// recognitionLocale) resolving engine.recognitionLocale() -> loadVoiceRecognitionLanguage. The two do not
// share one instance of this module — the shell's bundle and the page's webview bundle each evaluate it
// once, and each keeps its own memory — so the only channel a save is guaranteed to reach the next arm
// through is AsyncStorage itself. Read it on every load: a process-lifetime cache pins the pre-save choice
// until restart, which is the stale arm #31 observed.

// Missing, empty, and overlong reads are Follow system; 35 is the bridge's locale schema's own bound.
function saneLocale(raw: string | null): string | null {
  return raw !== null && raw.length > 0 && raw.length <= 35 ? raw : null
}

export async function loadVoiceRecognitionLanguage(): Promise<string | null> {
  try {
    return saneLocale(await AsyncStorage.getItem(VOICE_RECOGNITION_LANGUAGE_KEY))
  } catch {
    // A save that landed while this read was failing has already chosen; one retry sees it instead of arming Follow system over a kept choice.
    return saneLocale(await AsyncStorage.getItem(VOICE_RECOGNITION_LANGUAGE_KEY).catch(() => null))
  }
}

export async function saveVoiceRecognitionLanguage(tag: string | null): Promise<void> {
  if (tag === null) {
    await AsyncStorage.removeItem(VOICE_RECOGNITION_LANGUAGE_KEY)
    return
  }
  await AsyncStorage.setItem(VOICE_RECOGNITION_LANGUAGE_KEY, tag)
}

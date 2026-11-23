import AsyncStorage from '@react-native-async-storage/async-storage'

// The locale the recognizer is armed in; null means Follow system, the page's locale unchanged. Phone-only: the shell resolves it, so the page never reads it.
const VOICE_RECOGNITION_LANGUAGE_KEY = 'orca:voiceRecognitionLanguage'

// The shell reads it before every recognizer arm; only this module writes it, so keep it in memory once read.
// undefined means not read yet; null is the stored Follow system choice.
let cached: string | null | undefined

export async function loadVoiceRecognitionLanguage(): Promise<string | null> {
  if (cached !== undefined) {
    return cached
  }
  try {
    const raw = await AsyncStorage.getItem(VOICE_RECOGNITION_LANGUAGE_KEY)
    // A save during the read wins over what the read found; the length bound is the bridge's locale schema's own.
    if (cached === undefined) {
      cached = raw !== null && raw.length > 0 && raw.length <= 35 ? raw : null
    }
    return cached
  } catch {
    return null
  }
}

export async function saveVoiceRecognitionLanguage(tag: string | null): Promise<void> {
  cached = tag
  if (tag === null) {
    await AsyncStorage.removeItem(VOICE_RECOGNITION_LANGUAGE_KEY)
    return
  }
  await AsyncStorage.setItem(VOICE_RECOGNITION_LANGUAGE_KEY, tag)
}

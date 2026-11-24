import { probeReadoutScriptLanguage } from '../../../src/shared/voice/readout-script-language'
import { onDeviceSpeechLocale } from '../platform/speech/on-device-speech-locale'
import type { VoiceModeReadoutLanguage } from '../storage/voice-mode-settings'

/**
 * The locale a lang-less readout is spoken in — the speak chain the readout-language stage
 * resolves. The model's own briefing.lang outranks this whole chain and never passes through it;
 * what arrives here is an utterance the machine left without a locale. Each stage names its own
 * answer: a chosen language speaks itself, follow-system hands the choice to the engine (locale
 * null is the TTS contract's "let the phone's own language choose"), and automatic probes the
 * prose about to be spoken — the same script probe the wash expands issue references by —
 * falling to the device's language when the script names none.
 */
export function readoutSpeakLocale(
  setting: VoiceModeReadoutLanguage,
  text: string,
  deviceLocale: string
): string | null {
  if (setting.mode === 'system') {
    return null
  }
  if (setting.mode === 'language') {
    return setting.tag
  }
  const probed = probeReadoutScriptLanguage(text)
  if (probed === null) {
    return deviceLocale
  }
  // A device already speaking the probed language keeps its own region: a zh-TW phone reads han
  // prose in zh-TW, not the canonical zh-CN.
  if (deviceLocale.toLowerCase().startsWith(probed)) {
    return deviceLocale
  }
  return probed === 'zh' ? 'zh-CN' : 'ja-JP'
}

/**
 * Binds the stage for one loop's life, the way the host wires it: the setting is fixed at the
 * loop's start like the toggles, while the device locale is read per utterance, so a system
 * language change mid-loop reaches the next reply.
 */
export function readoutLocaleResolver(
  setting: VoiceModeReadoutLanguage
): (text: string) => string | null {
  return (text) => readoutSpeakLocale(setting, text, onDeviceSpeechLocale())
}

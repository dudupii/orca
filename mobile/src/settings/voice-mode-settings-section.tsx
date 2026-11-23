import { useEffect, useState } from 'react'
import { hasNativeSpeech } from '@orca/expo-two-way-audio'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { ListRow } from '../components/list/ListGroup'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  loadVoiceModeResponseDelaySeconds,
  saveVoiceModeResponseDelaySeconds,
  VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS
} from '../storage/voice-mode-settings'
import {
  loadVoiceRecognitionLanguage,
  saveVoiceRecognitionLanguage
} from '../storage/voice-recognition-language'
import { SettingsSection } from './settings-screen-frame'
import {
  languageDisplayName,
  VoiceRecognitionLanguagePicker
} from './voice-recognition-language-picker'

// The choices the row offers inside the clamped 0–3s range; the storage clamps anything else.
export const VOICE_MODE_RESPONSE_DELAY_CHOICES = [0, 1, 1.5, 2, 3] as const

// The loop runs on this phone, so its settings show without a paired computer.
export function voiceModeSettingsShown(): boolean {
  return hasNativeSpeech()
}

// This ticket's slice of voice mode: the response-delay row and the recognition language. Later tickets append their own rows here.
export function VoiceModeSettingsSection() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [delaySeconds, setDelaySeconds] = useState(VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS)
  const [language, setLanguage] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!voiceModeSettingsShown()) {
      return
    }
    void loadVoiceModeResponseDelaySeconds().then(setDelaySeconds)
    void loadVoiceRecognitionLanguage().then(setLanguage)
  }, [])

  if (!voiceModeSettingsShown()) {
    return null
  }

  const choose = (seconds: number) => {
    setDelaySeconds(seconds)
    void saveVoiceModeResponseDelaySeconds(seconds).catch(() => {})
  }

  const chooseLanguage = (tag: string | null) => {
    setLanguage(tag)
    void saveVoiceRecognitionLanguage(tag).catch(() => {})
  }

  const followSystem = t(
    'settings.voiceSettingsScreen.recognitionLanguageFollowSystem',
    'Follow system'
  )

  return (
    <>
      <SettingsSection
        title={t('settings.voiceSettingsScreen.voiceModeHeading', 'VOICE MODE')}
        footer={t(
          'settings.voiceSettingsScreen.voiceModeResponseDelayDescription',
          'How long a finished voice message waits before it sends. Tap it while it waits to cancel sending.'
        )}
      >
        <ListRow
          key="responseDelay"
          title={t('settings.voiceSettingsScreen.voiceModeResponseDelay', 'Response Delay')}
          accessory={
            <MobileSegmentedControl
              segments={VOICE_MODE_RESPONSE_DELAY_CHOICES.map((seconds) => ({
                value: String(seconds),
                label: t('settings.voiceSettingsScreen.voiceModeDelaySeconds', '{{value}}s', {
                  value: String(seconds)
                })
              }))}
              selected={String(delaySeconds)}
              onSelect={(value) => choose(Number(value))}
              testIDPrefix="voice-response-delay-"
            />
          }
        />
        <ListRow
          key="recognitionLanguage"
          title={t('settings.voiceSettingsScreen.recognitionLanguage', 'Recognition Language')}
          subtitle={language === null ? followSystem : languageDisplayName(language)}
          navigates
          testID="voice-recognition-language-picker"
          onPress={() => setPickerOpen(true)}
        />
      </SettingsSection>
      {/* The drawer's own native Modal escapes the section's scroll view, so it can mount here. */}
      <BottomDrawer visible={pickerOpen} onClose={() => setPickerOpen(false)}>
        <VoiceRecognitionLanguagePicker selected={language} onSelect={chooseLanguage} />
      </BottomDrawer>
    </>
  )
}

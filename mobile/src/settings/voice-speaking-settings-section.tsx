import { useEffect, useState } from 'react'
import { hasNativeTts } from '@orca/expo-two-way-audio'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { ListRow } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  loadVoiceModeBargeIn,
  loadVoiceModeFallbackReadout,
  loadVoiceModeReadoutLanguage,
  saveVoiceModeBargeIn,
  saveVoiceModeFallbackReadout,
  saveVoiceModeReadoutLanguage,
  VOICE_MODE_BARGE_IN_DEFAULT,
  VOICE_MODE_FALLBACK_READOUT_DEFAULT,
  VOICE_MODE_READOUT_LANGUAGE_DEFAULT,
  type VoiceModeReadoutLanguage
} from '../storage/voice-mode-settings'
import { SettingsSection } from './settings-screen-frame'
import { languageDisplayName } from './voice-recognition-language-picker'
import { VoiceReadoutLanguagePicker } from './voice-readout-language-picker'

// The loop speaks on this phone's own engine, so its speaking rows show without a paired computer.
export function voiceSpeakingSettingsShown(): boolean {
  return hasNativeTts()
}

// The speaking side of voice mode: barge-in, the fallback readout, and the language a lang-less
// reply is read in. The loop reads all three at its start.
export function VoiceSpeakingSettingsSection() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [bargeIn, setBargeIn] = useState(VOICE_MODE_BARGE_IN_DEFAULT)
  const [fallbackReadout, setFallbackReadout] = useState(VOICE_MODE_FALLBACK_READOUT_DEFAULT)
  const [readoutLanguage, setReadoutLanguage] = useState<VoiceModeReadoutLanguage>(
    VOICE_MODE_READOUT_LANGUAGE_DEFAULT
  )
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!voiceSpeakingSettingsShown()) {
      return
    }
    void loadVoiceModeBargeIn().then(setBargeIn)
    void loadVoiceModeFallbackReadout().then(setFallbackReadout)
    void loadVoiceModeReadoutLanguage().then(setReadoutLanguage)
  }, [])

  if (!voiceSpeakingSettingsShown()) {
    return null
  }

  const chooseBargeIn = (value: boolean) => {
    setBargeIn(value)
    void saveVoiceModeBargeIn(value).catch(() => {})
  }

  const chooseFallbackReadout = (value: boolean) => {
    setFallbackReadout(value)
    void saveVoiceModeFallbackReadout(value).catch(() => {})
  }

  const chooseReadoutLanguage = (setting: VoiceModeReadoutLanguage) => {
    setReadoutLanguage(setting)
    void saveVoiceModeReadoutLanguage(setting).catch(() => {})
  }

  const readoutLanguageName =
    readoutLanguage.mode === 'automatic'
      ? t('settings.voiceSettingsScreen.readoutLanguageAutomatic', 'Automatic')
      : readoutLanguage.mode === 'system'
        ? t('settings.voiceSettingsScreen.readoutLanguageFollowSystem', 'Follow system')
        : languageDisplayName(readoutLanguage.tag)

  return (
    <>
      <SettingsSection
        title={t('settings.voiceSettingsScreen.voiceSpeakingHeading', 'SPEAKING')}
        footer={t(
          'settings.voiceSettingsScreen.voiceSpeakingDescription',
          'Applies the next time voice mode starts.'
        )}
      >
        <ListRow
          key="bargeIn"
          title={t('settings.voiceSettingsScreen.voiceBargeIn', 'Interrupt with Your Voice')}
          subtitle={t(
            'settings.voiceSettingsScreen.voiceBargeInDescription',
            'Speaking during a readout stops it. A tap on the readout always stops it.'
          )}
          accessory={
            <MobileSwitch
              testID="voice-barge-in"
              accessibilityLabel={t(
                'settings.voiceSettingsScreen.voiceBargeIn',
                'Interrupt with Your Voice'
              )}
              value={bargeIn}
              onValueChange={chooseBargeIn}
            />
          }
        />
        <ListRow
          key="fallbackReadout"
          title={t('settings.voiceSettingsScreen.voiceFallbackReadout', 'Read Replies Aloud')}
          subtitle={t(
            'settings.voiceSettingsScreen.voiceFallbackReadoutDescription',
            'Read the first sentences of replies that ship no spoken briefing.'
          )}
          accessory={
            <MobileSwitch
              testID="voice-fallback-readout"
              accessibilityLabel={t(
                'settings.voiceSettingsScreen.voiceFallbackReadout',
                'Read Replies Aloud'
              )}
              value={fallbackReadout}
              onValueChange={chooseFallbackReadout}
            />
          }
        />
        <ListRow
          key="readoutLanguage"
          title={t('settings.voiceSettingsScreen.readoutLanguage', 'Readout Language')}
          subtitle={readoutLanguageName}
          navigates
          testID="voice-readout-language-picker"
          onPress={() => setPickerOpen(true)}
        />
      </SettingsSection>
      {/* The drawer's own native Modal escapes the section's scroll view, so it can mount here. */}
      <BottomDrawer visible={pickerOpen} onClose={() => setPickerOpen(false)}>
        <VoiceReadoutLanguagePicker selected={readoutLanguage} onSelect={chooseReadoutLanguage} />
      </BottomDrawer>
    </>
  )
}

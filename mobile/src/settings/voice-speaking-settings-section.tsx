import { useEffect, useState } from 'react'
import { hasNativeTts } from '@orca/expo-two-way-audio'
import { ListRow } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  loadVoiceModeBargeIn,
  loadVoiceModeFallbackReadout,
  saveVoiceModeBargeIn,
  saveVoiceModeFallbackReadout,
  VOICE_MODE_BARGE_IN_DEFAULT,
  VOICE_MODE_FALLBACK_READOUT_DEFAULT
} from '../storage/voice-mode-settings'
import { SettingsSection } from './settings-screen-frame'

// The loop speaks on this phone's own engine, so its speaking rows show without a paired computer.
export function voiceSpeakingSettingsShown(): boolean {
  return hasNativeTts()
}

// The speaking side of voice mode: barge-in and the fallback readout. The loop reads both at its start.
export function VoiceSpeakingSettingsSection() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [bargeIn, setBargeIn] = useState(VOICE_MODE_BARGE_IN_DEFAULT)
  const [fallbackReadout, setFallbackReadout] = useState(VOICE_MODE_FALLBACK_READOUT_DEFAULT)

  useEffect(() => {
    if (!voiceSpeakingSettingsShown()) {
      return
    }
    void loadVoiceModeBargeIn().then(setBargeIn)
    void loadVoiceModeFallbackReadout().then(setFallbackReadout)
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

  return (
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
    </SettingsSection>
  )
}

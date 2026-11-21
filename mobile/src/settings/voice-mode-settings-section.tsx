import { useEffect, useState } from 'react'
import { hasNativeSpeech } from '@orca/expo-two-way-audio'
import { ListRow } from '../components/list/ListGroup'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  loadVoiceModeResponseDelaySeconds,
  saveVoiceModeResponseDelaySeconds,
  VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS
} from '../storage/voice-mode-settings'
import { SettingsSection } from './settings-screen-frame'

// The choices the row offers inside the clamped 0–3s range; the storage clamps anything else.
export const VOICE_MODE_RESPONSE_DELAY_CHOICES = [0, 1, 1.5, 2, 3] as const

// The loop runs on this phone, so its settings show without a paired computer.
export function voiceModeSettingsShown(): boolean {
  return hasNativeSpeech()
}

// This ticket's slice of voice mode: the response-delay row. Later tickets append their own rows here.
export function VoiceModeSettingsSection() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [delaySeconds, setDelaySeconds] = useState(VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS)

  useEffect(() => {
    if (!voiceModeSettingsShown()) {
      return
    }
    void loadVoiceModeResponseDelaySeconds().then(setDelaySeconds)
  }, [])

  if (!voiceModeSettingsShown()) {
    return null
  }

  const choose = (seconds: number) => {
    setDelaySeconds(seconds)
    void saveVoiceModeResponseDelaySeconds(seconds).catch(() => {})
  }

  return (
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
    </SettingsSection>
  )
}

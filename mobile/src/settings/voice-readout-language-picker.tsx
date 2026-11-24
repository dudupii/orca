import { useMemo } from 'react'
import { Text } from 'react-native'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { VoiceModeReadoutLanguage } from '../storage/voice-mode-settings'
import { voiceSettingsStyles as styles } from './voice-settings-styles'
import { candidateTags, languageDisplayName } from './voice-recognition-language-picker'

/**
 * The readout-language stage's choices: automatic probes each reply and falls to the device's
 * language, follow-system hands the choice to the engine, and a tag names one outright. The
 * language list is the recognition picker's own — the device's languages plus a stored choice —
 * without its recognizer probing: a language with no installed voice is the engine's problem at
 * speak time, and its failed utterance settles as a failed playback, never a broken loop.
 */
export function VoiceReadoutLanguagePicker({
  selected,
  onSelect
}: {
  /** The stored stage; automatic is the default an install that never chose reads. */
  selected: VoiceModeReadoutLanguage
  onSelect: (setting: VoiceModeReadoutLanguage) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const tags = useMemo(
    () => candidateTags(selected.mode === 'language' ? selected.tag : null),
    [selected]
  )

  return (
    <>
      <Text style={styles.drawerTitle}>
        {t('settings.voiceSettingsScreen.readoutLanguage', 'Readout Language')}
      </Text>
      <ListGroup>
        <ListRow
          key="automatic"
          title={t('settings.voiceSettingsScreen.readoutLanguageAutomatic', 'Automatic')}
          subtitle={t(
            'settings.voiceSettingsScreen.readoutLanguageAutomaticDescription',
            'Reads each reply in the language it is written in, falling back to the phone’s language.'
          )}
          selected={selected.mode === 'automatic'}
          onPress={() => onSelect({ mode: 'automatic' })}
        />
        <ListRow
          key="followSystem"
          title={t('settings.voiceSettingsScreen.readoutLanguageFollowSystem', 'Follow system')}
          selected={selected.mode === 'system'}
          onPress={() => onSelect({ mode: 'system' })}
        />
        {tags.map((tag) => (
          <ListRow
            key={tag}
            title={languageDisplayName(tag)}
            selected={selected.mode === 'language' && selected.tag === tag}
            onPress={() => onSelect({ mode: 'language', tag })}
          />
        ))}
      </ListGroup>
    </>
  )
}

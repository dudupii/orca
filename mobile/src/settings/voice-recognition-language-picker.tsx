import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Text } from 'react-native'
import {
  addExpoTwoWayAudioEventListener,
  speechAvailability,
  speechDownload,
  type SpeechAvailabilityStatus
} from '@orca/expo-two-way-audio'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { readDeviceUiLocaleTags } from '../i18n/system-ui-locale'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { isSpeechBusyError } from '../platform/speech/native-speech'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { phoneStatusText } from './voice-transcribe-on-section'
import { voiceSettingsStyles as styles } from './voice-settings-styles'

type RecognitionLanguageSpeech =
  | { status: SpeechAvailabilityStatus | 'checking'; resolved: string | null }
  | { status: 'downloading'; progress: number }

// Hermes may lack Intl.DisplayNames; the raw tag is the honest name then.
export function languageDisplayName(tag: string): string {
  if (typeof Intl.DisplayNames !== 'function') {
    return tag
  }
  try {
    return new Intl.DisplayNames([getUiIntlLocale()], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

// The device's whole UI preference list plus a stored choice the system no longer lists; probed, never a hardcoded catalog.
function candidateTags(selected: string | null): string[] {
  const tags: string[] = []
  for (const tag of [...readDeviceUiLocaleTags(), ...(selected === null ? [] : [selected])]) {
    if (!tags.includes(tag)) {
      tags.push(tag)
    }
  }
  return tags
}

// The progress event carries the engine's resolved locale, so match either spelling of the row.
function localeMatches(eventLocale: string, tag: string, resolved: string | null): boolean {
  return [tag, resolved].some(
    (candidate) => candidate !== null && candidate.toLowerCase() === eventLocale.toLowerCase()
  )
}

const PHONE_SPEECH_RECHECK_MS = 3_000

export function VoiceRecognitionLanguagePicker({
  selected,
  onSelect
}: {
  /** The stored device tag, or null for Follow system. */
  selected: string | null
  onSelect: (tag: string | null) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const tags = useMemo(() => candidateTags(selected), [selected])
  const [speech, setSpeech] = useState<Record<string, RecognitionLanguageSpeech>>({})
  // Progress events and the download's promise arrive apart; a late event must not reopen a finished download.
  const downloadingRef = useRef<{ tag: string; resolved: string | null } | null>(null)
  const probedRef = useRef<Set<string>>(new Set())

  // A busy speech service shows as checking and is asked again while the picker is open; it is never read as unsupported.
  const readTag = useCallback(async (tag: string) => {
    try {
      const available = await speechAvailability(tag)
      setSpeech((prev) => ({
        ...prev,
        [tag]: { status: available.status, resolved: available.locale }
      }))
    } catch (error) {
      setSpeech((prev) => ({
        ...prev,
        [tag]: { status: isSpeechBusyError(error) ? 'checking' : 'unsupported', resolved: null }
      }))
    }
  }, [])

  // Keyed on the state object: each busy answer is a new one, so it schedules the next check.
  useEffect(() => {
    const checking = Object.entries(speech).filter(([, value]) => value.status === 'checking')
    if (checking.length === 0) {
      return
    }
    const recheck = setTimeout(
      () => checking.forEach(([tag]) => void readTag(tag)),
      PHONE_SPEECH_RECHECK_MS
    )
    return () => clearTimeout(recheck)
  }, [speech, readTag])

  useEffect(() => {
    for (const tag of tags) {
      if (probedRef.current.has(tag)) {
        continue
      }
      probedRef.current.add(tag)
      void readTag(tag)
    }
  }, [tags, readTag])

  useEffect(() => {
    const progress = addExpoTwoWayAudioEventListener('onSpeechDownloadProgress', (event) => {
      const downloading = downloadingRef.current
      if (
        downloading === null ||
        !localeMatches(event.locale, downloading.tag, downloading.resolved)
      ) {
        return
      }
      setSpeech((prev) => ({
        ...prev,
        [downloading.tag]: {
          status: 'downloading',
          progress: Math.min(1, Math.max(0, event.fraction))
        }
      }))
    })
    return () => progress.remove()
  }, [])

  const download = (tag: string, resolved: string | null) => {
    if (downloadingRef.current !== null) {
      return
    }
    downloadingRef.current = { tag, resolved }
    setSpeech((prev) => ({ ...prev, [tag]: { status: 'downloading', progress: 0 } }))
    void speechDownload(tag)
      .catch(() => false)
      .then(() => {
        downloadingRef.current = null
        return readTag(tag)
      })
  }

  return (
    <>
      <Text style={styles.drawerTitle}>
        {t('settings.voiceSettingsScreen.recognitionLanguage', 'Recognition Language')}
      </Text>
      <ListGroup>
        <ListRow
          key="followSystem"
          title={t('settings.voiceSettingsScreen.recognitionLanguageFollowSystem', 'Follow system')}
          selected={selected === null}
          onPress={() => onSelect(null)}
        />
        {tags.map((tag) => {
          const state = speech[tag]
          const downloading = state?.status === 'downloading'
          return (
            <Fragment key={tag}>
              <ListRow
                title={languageDisplayName(tag)}
                subtitle={phoneStatusText(state ?? null, t)}
                selected={selected === tag}
                disabled={state?.status === 'unsupported'}
                onPress={() => onSelect(tag)}
              />
              {state?.status === 'needs-download' || downloading ? (
                <ListRow
                  title={t('settings.voiceTranscribeOn.download', 'Download for this phone')}
                  busy={downloading}
                  onPress={() => {
                    if (state?.status === 'needs-download') {
                      download(tag, state.resolved)
                    }
                  }}
                />
              ) : null}
            </Fragment>
          )
        })}
      </ListGroup>
    </>
  )
}

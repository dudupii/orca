import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { speechAvailability, speechDownload } from '@orca/expo-two-way-audio'
import { readDeviceUiLocaleTags } from '../i18n/system-ui-locale'
import type * as SystemUiLocale from '../i18n/system-ui-locale'
import { VoiceRecognitionLanguagePicker, candidateTags } from './voice-recognition-language-picker'
import { parseSpeechLocaleInput, voiceLanguageCandidateTags } from './voice-language-catalog'
import { findAllByHostType, findByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock(
  './settings-screen-frame',
  async () => (await import('../test-support/settings-chrome-test-double')).settingsFrameDouble
)
vi.mock(
  '../components/list/ListGroup',
  async () => (await import('../test-support/settings-chrome-test-double')).listGroupDouble
)
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('expo-localization', () => ({ getLocales: vi.fn(() => []) }))
vi.mock('../i18n/system-ui-locale', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemUiLocale>()),
  readDeviceUiLocaleTags: vi.fn((): string[] => [])
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  hasNativeSpeech: vi.fn(() => true),
  speechAvailability: vi.fn(async () => ({ status: 'ready', locale: null })),
  speechDownload: vi.fn(async () => true),
  addExpoTwoWayAudioEventListener: vi.fn(() => ({ remove: vi.fn() }))
}))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

function setDeviceTags(tags: string[]): void {
  vi.mocked(readDeviceUiLocaleTags).mockReturnValue(tags)
}

// The chrome double is itself a component that carries the row's props, so match the host element it renders.
function rowByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = findAllByHostType(root, 'ListRow').filter((row) => row.props.testID === testID)
  if (found.length !== 1) {
    throw new Error(`expected one row with testID ${testID}, found ${found.length}`)
  }
  return found[0]!
}

function otherErrorRows(root: ReactTestInstance): ReactTestInstance[] {
  return findAllByHostType(root, 'Text').filter(
    (node) => node.props.testID === 'voice-recognition-language-other-error'
  )
}

async function renderPicker(selected: string | null): Promise<ReactTestRenderer> {
  const onSelect = vi.fn()
  await act(async () => {
    renderer = create(createElement(VoiceRecognitionLanguagePicker, { selected, onSelect }))
  })
  return renderer
}

describe('voice language candidates', () => {
  it('lists the system languages first, then the catalog, without the system-duplicated and bare-folded entries', () => {
    const tags = voiceLanguageCandidateTags(['ja-JP'], null)
    expect(tags[0]).toBe('ja-JP')
    expect(tags).toContain('zh-CN')
    // The catalog's ja-JP duplicates the system entry exactly; the catalog has no bare ja to fold.
    expect(tags.filter((tag) => tag.toLowerCase().startsWith('ja'))).toEqual(['ja-JP'])
    // System first, catalog after: every catalog survivor follows the system entry.
    expect(tags.indexOf('ar')).toBe(1)
  })

  it('folds a bare catalog language under a regional system tag, keeping the unrelated rows', () => {
    // The system's en-US covers English, so the catalog's bare en is folded away; de and ja-JP stay.
    const tags = voiceLanguageCandidateTags(['en-US'], null)
    expect(tags[0]).toBe('en-US')
    expect(tags).not.toContain('en')
    expect(tags).toContain('de')
    expect(tags).toContain('ja-JP')
  })

  it('keeps a stored choice that neither the system list nor the catalog spells', () => {
    const tags = voiceLanguageCandidateTags(['ja-JP'], 'tl')
    expect(tags[0]).toBe('ja-JP')
    expect(tags[1]).toBe('tl')
    expect(tags.filter((tag) => tag === 'tl')).toHaveLength(1)
  })

  it('folds case variants into one row', () => {
    const tags = voiceLanguageCandidateTags(['zh-CN'], 'zh-cn')
    expect(tags.filter((tag) => tag.toLowerCase() === 'zh-cn')).toEqual(['zh-CN'])
  })

  it('never folds script or region variants of the same language', () => {
    const tags = voiceLanguageCandidateTags(['zh-Hans-CN', 'pt-PT'], null)
    expect(tags).toContain('zh-CN')
    expect(tags).toContain('zh-TW')
    expect(tags).toContain('pt-BR')
    expect(tags).toContain('pt-PT')
  })
})

describe('speech locale input', () => {
  it('accepts well-formed tags, trimmed', () => {
    expect(parseSpeechLocaleInput('zh')).toBe('zh')
    expect(parseSpeechLocaleInput('zh-CN')).toBe('zh-CN')
    expect(parseSpeechLocaleInput('pt-BR')).toBe('pt-BR')
    expect(parseSpeechLocaleInput('yue')).toBe('yue')
    expect(parseSpeechLocaleInput(' zh-Hant-TW ')).toBe('zh-Hant-TW')
    expect(parseSpeechLocaleInput('en-x-private')).toBe('en-x-private')
  })

  it('rejects empty, malformed and over-long input', () => {
    expect(parseSpeechLocaleInput('')).toBeNull()
    expect(parseSpeechLocaleInput('   ')).toBeNull()
    expect(parseSpeechLocaleInput('not a tag!')).toBeNull()
    expect(parseSpeechLocaleInput('zh_CN')).toBeNull()
    expect(parseSpeechLocaleInput('zh-')).toBeNull()
    expect(parseSpeechLocaleInput('abcd')).toBeNull()
    expect(parseSpeechLocaleInput('a'.repeat(36))).toBeNull()
    // Shape-valid but past the bridge's 35-character bound.
    expect(parseSpeechLocaleInput(`en${'-variant'.repeat(5)}`)).toBeNull()
    expect(parseSpeechLocaleInput(`en${'-variant'.repeat(4)}`)).toBe(`en${'-variant'.repeat(4)}`)
  })
})

describe('voice recognition language picker', () => {
  it('renders the system language, then catalog rows, and probes every row once', async () => {
    setDeviceTags(['ja-JP'])
    await renderPicker(null)
    const rows = findAllByHostType(renderer.root, 'ListRow')
    expect(rows[0]?.props.selected).toBe(true)
    expect(rowByTestId(renderer.root, 'voice-recognition-language-ja-JP')).toBeTruthy()
    expect(rowByTestId(renderer.root, 'voice-recognition-language-zh-CN')).toBeTruthy()
    expect(
      renderer.root.findAll((node) => node.props.testID === 'voice-recognition-language-ja')
    ).toHaveLength(0)
    expect(rowByTestId(renderer.root, 'voice-recognition-language-other')).toBeTruthy()

    const tags = candidateTags(null)
    expect(vi.mocked(speechAvailability)).toHaveBeenCalledTimes(tags.length)
    for (const tag of tags) {
      expect(speechAvailability).toHaveBeenCalledWith(tag)
    }
  })

  it('selects a catalog language through onSelect', async () => {
    setDeviceTags(['ja-JP'])
    const onSelect = vi.fn()
    await act(async () => {
      renderer = create(createElement(VoiceRecognitionLanguagePicker, { selected: null, onSelect }))
    })
    await act(async () => {
      rowByTestId(renderer.root, 'voice-recognition-language-zh-CN').props.onPress()
    })
    expect(onSelect).toHaveBeenCalledWith('zh-CN')
  })

  it('round-trips a custom tag: typed, validated, selected on its own row', async () => {
    setDeviceTags(['ja-JP'])
    const onSelect = vi.fn()
    await act(async () => {
      renderer = create(createElement(VoiceRecognitionLanguagePicker, { selected: null, onSelect }))
    })
    await act(async () => {
      rowByTestId(renderer.root, 'voice-recognition-language-other').props.onPress()
    })
    const input = findByHostType(renderer.root, 'TextInput')
    await act(async () => {
      input.props.onChangeText('yue')
    })
    await act(async () => {
      rowByTestId(renderer.root, 'voice-recognition-language-other-use').props.onPress()
    })
    expect(onSelect).toHaveBeenCalledWith('yue')
    // The stored choice re-enters as a visible, checked row of its own.
    await act(async () => {
      renderer.unmount()
      renderer = create(
        createElement(VoiceRecognitionLanguagePicker, { selected: 'yue', onSelect })
      )
    })
    const customRow = rowByTestId(renderer.root, 'voice-recognition-language-yue')
    expect(customRow.props.selected).toBe(true)
  })

  it('shows a visible error and saves nothing on an invalid custom tag', async () => {
    setDeviceTags([])
    const onSelect = vi.fn()
    await act(async () => {
      renderer = create(createElement(VoiceRecognitionLanguagePicker, { selected: null, onSelect }))
    })
    await act(async () => {
      rowByTestId(renderer.root, 'voice-recognition-language-other').props.onPress()
    })
    expect(otherErrorRows(renderer.root)).toHaveLength(0)
    await act(async () => {
      findByHostType(renderer.root, 'TextInput').props.onChangeText('not a tag!')
    })
    await act(async () => {
      rowByTestId(renderer.root, 'voice-recognition-language-other-use').props.onPress()
    })
    expect(otherErrorRows(renderer.root)).toHaveLength(1)
    // The error announces itself to screen readers, like the settings error-note path.
    expect(otherErrorRows(renderer.root)[0]?.props.accessibilityRole).toBe('alert')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('holds the explicit not-ready states at catalog volume', async () => {
    setDeviceTags([])
    vi.mocked(speechAvailability).mockResolvedValue({ status: 'needs-download', locale: null })
    await renderPicker(null)
    const downloadRow = rowByTestId(renderer.root, 'voice-recognition-language-download-zh-CN')
    await act(async () => {
      downloadRow.props.onPress()
    })
    expect(speechDownload).toHaveBeenCalledWith('zh-CN')

    vi.mocked(speechAvailability).mockResolvedValue({ status: 'unsupported', locale: null })
    await act(async () => {
      renderer.unmount()
      renderer = create(
        createElement(VoiceRecognitionLanguagePicker, { selected: null, onSelect: vi.fn() })
      )
    })
    expect(rowByTestId(renderer.root, 'voice-recognition-language-zh-CN').props.disabled).toBe(true)
  })
})

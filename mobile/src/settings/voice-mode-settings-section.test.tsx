import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceModeSettingsSection } from './voice-mode-settings-section'
import {
  loadVoiceModeResponseDelaySeconds,
  saveVoiceModeResponseDelaySeconds
} from '../storage/voice-mode-settings'
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
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('@orca/expo-two-way-audio', () => ({ hasNativeSpeech: vi.fn(() => true) }))
vi.mock('../storage/voice-mode-settings', () => ({
  VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS: 1.5,
  loadVoiceModeResponseDelaySeconds: vi.fn(async () => 1.5),
  saveVoiceModeResponseDelaySeconds: vi.fn(async () => {})
}))
vi.mock('../components/controls/MobileSegmentedControl', () => ({
  MobileSegmentedControl: (props: Record<string, unknown>) =>
    createElement('MobileSegmentedControl', props)
}))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: (props: Record<string, unknown>) => createElement('BottomDrawer', props)
}))
vi.mock('../storage/voice-recognition-language', () => ({
  loadVoiceRecognitionLanguage: vi.fn(async () => null),
  saveVoiceRecognitionLanguage: vi.fn(async () => {})
}))
vi.mock('./voice-recognition-language-picker', () => ({
  languageDisplayName: (tag: string) => tag,
  VoiceRecognitionLanguagePicker: (props: Record<string, unknown>) =>
    createElement('VoiceRecognitionLanguagePicker', props)
}))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

describe('voice mode settings section', () => {
  it('loads the saved delay and saves a new choice inside the row', async () => {
    vi.mocked(loadVoiceModeResponseDelaySeconds).mockResolvedValue(2)
    await act(async () => {
      renderer = create(createElement(VoiceModeSettingsSection))
    })
    expect(findAllByHostType(renderer.root, 'ListRow')).toHaveLength(2)
    const control = findByHostType(renderer.root, 'MobileSegmentedControl')
    expect(control.props.selected).toBe('2')

    await act(async () => {
      control.props.onSelect('0')
    })
    expect(saveVoiceModeResponseDelaySeconds).toHaveBeenCalledWith(0)
    expect(findByHostType(renderer.root, 'MobileSegmentedControl').props.selected).toBe('0')
  })

  it('offers the 0–3s range with the default selected', async () => {
    await act(async () => {
      renderer = create(createElement(VoiceModeSettingsSection))
    })
    const control = findByHostType(renderer.root, 'MobileSegmentedControl')
    expect(control.props.selected).toBe('1.5')
    expect(control.props.segments.map((segment: { value: string }) => segment.value)).toEqual([
      '0',
      '1',
      '1.5',
      '2',
      '3'
    ])
  })

  it('hides the section on a shell that cannot recognize speech', async () => {
    const { hasNativeSpeech } = await import('@orca/expo-two-way-audio')
    vi.mocked(hasNativeSpeech).mockReturnValue(false)
    await act(async () => {
      renderer = create(createElement(VoiceModeSettingsSection))
    })
    expect(findAllByHostType(renderer.root, 'ListRow')).toHaveLength(0)
  })
})

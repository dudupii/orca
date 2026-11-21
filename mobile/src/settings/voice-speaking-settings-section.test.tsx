import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceSpeakingSettingsSection } from './voice-speaking-settings-section'
import {
  loadVoiceModeBargeIn,
  loadVoiceModeFallbackReadout,
  saveVoiceModeBargeIn,
  saveVoiceModeFallbackReadout
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
vi.mock('@orca/expo-two-way-audio', () => ({ hasNativeTts: vi.fn(() => true) }))
vi.mock('../storage/voice-mode-settings', () => ({
  VOICE_MODE_BARGE_IN_DEFAULT: true,
  VOICE_MODE_FALLBACK_READOUT_DEFAULT: true,
  loadVoiceModeBargeIn: vi.fn(async () => true),
  saveVoiceModeBargeIn: vi.fn(async () => {}),
  loadVoiceModeFallbackReadout: vi.fn(async () => true),
  saveVoiceModeFallbackReadout: vi.fn(async () => {})
}))
vi.mock('../components/controls/MobileSwitch', () => ({
  MobileSwitch: (props: Record<string, unknown>) => createElement('MobileSwitch', props)
}))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

describe('voice speaking settings section', () => {
  it('loads both saved toggles and saves each choice on its own row', async () => {
    vi.mocked(loadVoiceModeBargeIn).mockResolvedValue(false)
    vi.mocked(loadVoiceModeFallbackReadout).mockResolvedValue(true)
    await act(async () => {
      renderer = create(createElement(VoiceSpeakingSettingsSection))
    })
    const switches = findAllByHostType(renderer.root, 'MobileSwitch')
    expect(switches).toHaveLength(2)
    expect(switches[0]?.props.value).toBe(false)
    expect(switches[1]?.props.value).toBe(true)

    await act(async () => {
      switches[0]?.props.onValueChange(true)
    })
    expect(saveVoiceModeBargeIn).toHaveBeenCalledWith(true)
    expect(findAllByHostType(renderer.root, 'MobileSwitch')[0]?.props.value).toBe(true)

    await act(async () => {
      findAllByHostType(renderer.root, 'MobileSwitch')[1]?.props.onValueChange(false)
    })
    expect(saveVoiceModeFallbackReadout).toHaveBeenCalledWith(false)
    expect(findAllByHostType(renderer.root, 'MobileSwitch')[1]?.props.value).toBe(false)
  })

  it('renders nothing on a phone without the tts engine', async () => {
    const { hasNativeTts } = await import('@orca/expo-two-way-audio')
    vi.mocked(hasNativeTts).mockReturnValue(false)
    await act(async () => {
      renderer = create(createElement(VoiceSpeakingSettingsSection))
    })
    expect(findAllByHostType(renderer.root, 'ListRow')).toHaveLength(0)
  })

  it('keeps both rows inside one settings section', async () => {
    await act(async () => {
      renderer = create(createElement(VoiceSpeakingSettingsSection))
    })
    expect(findAllByHostType(renderer.root, 'SettingsSection')).toHaveLength(1)
    expect(findByHostType(renderer.root, 'SettingsSection').props.title).toBe('SPEAKING')
  })
})

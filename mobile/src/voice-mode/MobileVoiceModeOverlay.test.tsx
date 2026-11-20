import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileVoiceModeOverlay } from './MobileVoiceModeOverlay'
import type { MobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import type { VoiceLoopView } from './voice-loop-shell'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('lucide-react-native', () => ({ X: 'Icon' }))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

function renderOverlay(view: VoiceLoopView): { exit: () => void; tapPending: () => void } {
  const exit = vi.fn()
  const tapPending = vi.fn()
  const voiceMode: MobileSessionVoiceMode = {
    view,
    entryAvailable: true,
    start: () => {},
    tapPending,
    exit
  }
  act(() => {
    renderer = create(createElement(MobileVoiceModeOverlay, { voiceMode }))
  })
  return { exit, tapPending }
}

describe('MobileVoiceModeOverlay', () => {
  it('shows the loop state with the live transcript and exits on ✕', () => {
    const { exit } = renderOverlay({
      route: 'listening',
      transcript: 'hello',
      pending: null,
      reply: null
    })
    const texts = findAllByHostType(renderer.root, 'Text')
    expect(texts[0]?.props.children).toBe('Listening…')
    expect(texts.some((node) => String(node.props.children).includes('hello'))).toBe(true)

    act(() => {
      findAllByHostType(renderer.root, 'Pressable')[0]?.props.onPress()
    })
    expect(exit).toHaveBeenCalledOnce()
  })

  it('offers the waiting utterance and cancels its send on tap', () => {
    const { tapPending } = renderOverlay({
      route: 'listening',
      transcript: 'hello',
      pending: 'hello',
      reply: null
    })
    const pending = findAllByHostType(renderer.root, 'Pressable').find((node) =>
      String(node.props.accessibilityLabel ?? '').includes('hello')
    )
    expect(pending).toBeDefined()

    act(() => {
      pending?.props.onPress()
    })
    expect(tapPending).toHaveBeenCalledOnce()
  })

  it('renders nothing once the loop has closed', () => {
    renderOverlay({ route: 'closed', transcript: '', pending: null, reply: null })
    expect(findAllByHostType(renderer.root, 'View')).toHaveLength(0)
  })
})

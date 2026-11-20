import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileVoiceModeOverlay } from './MobileVoiceModeOverlay'
import type { MobileSessionVoiceMode } from './use-mobile-session-voice-mode'
import type { VoiceLoopView } from './voice-loop-shell-contract'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('lucide-react-native', () => ({ Square: 'StopIcon', X: 'Icon' }))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  vi.resetAllMocks()
})

function renderOverlay(view: VoiceLoopView): {
  exit: () => void
  tapPending: () => void
  stopSpeaking: () => void
} {
  const exit = vi.fn()
  const tapPending = vi.fn()
  const stopSpeaking = vi.fn()
  const voiceMode: MobileSessionVoiceMode = {
    view,
    entryAvailable: true,
    start: () => {},
    tapPending,
    stopSpeaking,
    exit
  }
  act(() => {
    renderer = create(createElement(MobileVoiceModeOverlay, { voiceMode }))
  })
  return { exit, tapPending, stopSpeaking }
}

describe('MobileVoiceModeOverlay', () => {
  it('shows the live transcript and exits on ✕', () => {
    const { exit } = renderOverlay({
      route: 'listening',
      transcript: 'hello',
      pending: null,
      reply: null
    })
    const texts = findAllByHostType(renderer.root, 'Text')
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

  it('offers a stop control only while speaking, and a tap stops the readout', () => {
    const speaking = renderOverlay({
      route: 'speaking',
      transcript: '',
      pending: null,
      reply: 'Read aloud'
    })
    const stop = findAllByHostType(renderer.root, 'Pressable').find((node) =>
      String(node.props.accessibilityLabel ?? '').includes('Stop readout')
    )
    expect(stop).toBeDefined()

    act(() => {
      stop?.props.onPress()
    })
    expect(speaking.stopSpeaking).toHaveBeenCalledOnce()

    // While only listening there is nothing playing, so no stop control is offered.
    renderOverlay({ route: 'listening', transcript: 'hello', pending: null, reply: null })
    expect(
      findAllByHostType(renderer.root, 'Pressable').find((node) =>
        String(node.props.accessibilityLabel ?? '').includes('Stop readout')
      )
    ).toBeUndefined()
  })
})

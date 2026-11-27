import { describe, expect, it } from 'vitest'
import {
  shouldSuppressTerminalImeKeyboardEvent,
  type XtermBypassEvent,
  type XtermImeKeyboardOptions
} from './xterm-bypass-policy'

function keyEvent(overrides: Partial<XtermBypassEvent>): XtermBypassEvent {
  return {
    type: 'keydown',
    key: 'Enter',
    keyCode: 13,
    isComposing: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

function imeOptions(overrides: Partial<XtermImeKeyboardOptions>): XtermImeKeyboardOptions {
  return {
    compositionActive: false,
    candidateKeyGuardActive: false,
    pendingCandidateKeyReleaseActive: false,
    isMac: false,
    isAndroid: false,
    isLinux: true,
    ...overrides
  }
}

describe('shouldSuppressTerminalImeKeyboardEvent', () => {
  // fcitx4/Wayland can strand isComposing=true on Enter after compositionend never fires; the
  // tracker's live-composition view must free these keydowns instead of suppressing them forever.
  it('self-heals a non-229 keydown whose isComposing went stale while no composition is live', () => {
    expect(shouldSuppressTerminalImeKeyboardEvent(keyEvent({}), imeOptions({}))).toBe(false)
  })

  it('still suppresses IME-owned keys while a composition is live', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(keyEvent({}), imeOptions({ compositionActive: true }))
    ).toBe(true)
  })

  it('keeps passing idle standalone 229 keydowns on Linux', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        keyEvent({ key: 'Process', keyCode: 229 }),
        imeOptions({})
      )
    ).toBe(false)
  })

  it('keeps suppressing idle 229 keydowns on Windows', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        keyEvent({ key: 'Process', keyCode: 229 }),
        imeOptions({ isMac: false, isLinux: false })
      )
    ).toBe(true)
  })

  it('keeps suppressing stale-composing non-229 keydowns on Windows', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        keyEvent({}),
        imeOptions({ isMac: false, isLinux: false })
      )
    ).toBe(true)
  })

  it('self-heals stale-composing keydowns on macOS too', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        keyEvent({}),
        imeOptions({ isMac: true, isLinux: false })
      )
    ).toBe(false)
  })

  it('only keydowns self-heal; a stale-composing keyup stays suppressed', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(keyEvent({ type: 'keyup' }), imeOptions({}))
    ).toBe(true)
  })

  it('still suppresses fcitx candidate keys during the post-composition guard', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        keyEvent({ key: ' ', keyCode: 32 }),
        imeOptions({ candidateKeyGuardActive: true })
      )
    ).toBe(true)
  })
})

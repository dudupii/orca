import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fake verbs object standing in for use-native-verbs; only the tone surface is exercised.
const page = vi.hoisted(() => ({
  tonePlay: vi.fn((): Promise<void> => Promise.resolve()),
  canPlayTone: true
}))

vi.mock('../../mobile-web-shell/bridge/native-capabilities/use-native-verbs', () => ({
  useNativeVerbs: () => page
}))

import { useOnDeviceTone } from './on-device-tone.web'
import type { OnDeviceTone } from './on-device-tone-contract'

const held: { tone: OnDeviceTone | null } = { tone: null }
const trees: ReactTestRenderer[] = []

function mountTone(): OnDeviceTone | null {
  function Probe(): null {
    held.tone = useOnDeviceTone()
    return null
  }
  act(() => {
    trees.push(create(<Probe />))
  })
  return held.tone
}

beforeEach(() => {
  held.tone = null
  page.tonePlay.mockReset()
  page.tonePlay.mockReturnValue(Promise.resolve())
  page.canPlayTone = true
})

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
})

describe('a page the shell granted the tone verb', () => {
  it('plays a kind through native.tone.act', () => {
    const tone = mountTone()
    tone?.play('restore')
    expect(page.tonePlay).toHaveBeenCalledWith('restore')
  })

  it('swallows a refused or failed ask rather than surfacing it', async () => {
    page.tonePlay.mockRejectedValueOnce(new Error('this shell did not grant native.tone.act'))
    const tone = mountTone()
    tone?.play('restore')
    // The swallow happens in the promise the play fired; without it this rejection would fail the
    // run as unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(page.tonePlay).toHaveBeenCalledTimes(1)
  })
})

describe('a page the shell granted nothing', () => {
  it('reads as no tone at all, exactly as before this verb existed', () => {
    page.canPlayTone = false
    expect(mountTone()).toBeNull()
    expect(page.tonePlay).not.toHaveBeenCalled()
  })
})

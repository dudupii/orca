import { beforeEach, describe, expect, it, vi } from 'vitest'

const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    })
  }
}))

// The module keeps its loaded value in memory, so each read needs a fresh instance.
async function fresh(): Promise<typeof import('./voice-mode-settings')> {
  vi.resetModules()
  return await import('./voice-mode-settings')
}

describe('voice mode response delay storage', () => {
  beforeEach(() => {
    stored.clear()
    vi.resetModules()
  })

  it('clamps a saved delay to the 0–3s range and keeps the default inside it', async () => {
    const { clampVoiceModeResponseDelaySeconds, VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS } =
      await fresh()
    expect(clampVoiceModeResponseDelaySeconds(-1)).toBe(0)
    expect(clampVoiceModeResponseDelaySeconds(0)).toBe(0)
    expect(clampVoiceModeResponseDelaySeconds(1.5)).toBe(1.5)
    expect(clampVoiceModeResponseDelaySeconds(3)).toBe(3)
    expect(clampVoiceModeResponseDelaySeconds(5)).toBe(3)
    expect(clampVoiceModeResponseDelaySeconds(Number.NaN)).toBe(
      VOICE_MODE_RESPONSE_DELAY_DEFAULT_SECONDS
    )
  })

  it('round-trips a chosen delay and clamps what it reads back', async () => {
    const { saveVoiceModeResponseDelaySeconds, loadVoiceModeResponseDelaySeconds } = await fresh()
    await saveVoiceModeResponseDelaySeconds(2)
    expect(await loadVoiceModeResponseDelaySeconds()).toBe(2)
    stored.set('orca:voiceModeResponseDelaySeconds', '9')
    const reread = await fresh()
    expect(await reread.loadVoiceModeResponseDelaySeconds()).toBe(3)
  })

  it('reads the default when nothing is saved or the value is unreadable', async () => {
    const first = await fresh()
    expect(await first.loadVoiceModeResponseDelaySeconds()).toBe(1.5)
    stored.set('orca:voiceModeResponseDelaySeconds', 'not a number')
    const second = await fresh()
    expect(await second.loadVoiceModeResponseDelaySeconds()).toBe(1.5)
  })
})

describe('voice mode speaking toggles storage', () => {
  beforeEach(() => {
    stored.clear()
    vi.resetModules()
  })

  it('round-trips each toggle independently', async () => {
    const {
      saveVoiceModeBargeIn,
      loadVoiceModeBargeIn,
      saveVoiceModeFallbackReadout,
      loadVoiceModeFallbackReadout
    } = await fresh()
    expect(await loadVoiceModeBargeIn()).toBe(true)
    expect(await loadVoiceModeFallbackReadout()).toBe(true)
    await saveVoiceModeBargeIn(false)
    await saveVoiceModeFallbackReadout(false)
    expect(await loadVoiceModeBargeIn()).toBe(false)
    expect(await loadVoiceModeFallbackReadout()).toBe(false)
    // One toggle off leaves the other as it was saved.
    await saveVoiceModeFallbackReadout(true)
    expect(await loadVoiceModeBargeIn()).toBe(false)
    expect(await loadVoiceModeFallbackReadout()).toBe(true)
  })

  it('reads the default when nothing is saved or the value is not a boolean', async () => {
    stored.set('orca:voiceModeBargeIn', 'yes')
    stored.set('orca:voiceModeFallbackReadout', '1')
    const { loadVoiceModeBargeIn, loadVoiceModeFallbackReadout } = await fresh()
    expect(await loadVoiceModeBargeIn()).toBe(true)
    expect(await loadVoiceModeFallbackReadout()).toBe(true)
  })
})

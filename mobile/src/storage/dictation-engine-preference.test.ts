import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DictationEnginePreference from './dictation-engine-preference'

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
async function fresh(): Promise<typeof DictationEnginePreference> {
  vi.resetModules()
  return await import('./dictation-engine-preference')
}

describe('dictation engine preference storage', () => {
  beforeEach(() => {
    stored.clear()
    vi.resetModules()
  })

  it('round-trips a chosen engine', async () => {
    const { saveDictationEnginePreference, loadDictationEnginePreference } = await fresh()
    await saveDictationEnginePreference('phone')
    expect(stored.get('orca:dictationEngine')).toBe('phone')
    expect(await loadDictationEnginePreference()).toBe('phone')
  })

  it('reads automatic when nothing is saved', async () => {
    const { loadDictationEnginePreference } = await fresh()
    expect(await loadDictationEnginePreference()).toBe('automatic')
  })

  it('reads automatic for a stored value that is not a known engine', async () => {
    stored.set('orca:dictationEngine', 'carrier-pigeon')
    const { loadDictationEnginePreference } = await fresh()
    expect(await loadDictationEnginePreference()).toBe('automatic')
  })

  it('lets a save that arrives while the first read is failing win over the default', async () => {
    const { loadDictationEnginePreference, saveDictationEnginePreference } = await fresh()
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default
    let rejectRead: (error: Error) => void = () => {}
    vi.mocked(AsyncStorage.getItem).mockImplementationOnce(
      () =>
        new Promise<string | null>((_resolve, reject) => {
          rejectRead = reject
        })
    )
    const loading = loadDictationEnginePreference()
    await saveDictationEnginePreference('computer')
    rejectRead(new Error('storage unavailable'))
    expect(await loading).toBe('computer')
  })
})

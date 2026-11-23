import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as VoiceRecognitionLanguage from './voice-recognition-language'

const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      stored.delete(key)
    })
  }
}))

// The module keeps its loaded value in memory, so each read needs a fresh instance.
async function fresh(): Promise<typeof VoiceRecognitionLanguage> {
  vi.resetModules()
  return await import('./voice-recognition-language')
}

describe('voice recognition language storage', () => {
  beforeEach(() => {
    stored.clear()
    vi.resetModules()
  })

  it('round-trips a chosen language', async () => {
    const { saveVoiceRecognitionLanguage, loadVoiceRecognitionLanguage } = await fresh()
    await saveVoiceRecognitionLanguage('ja-JP')
    expect(stored.get('orca:voiceRecognitionLanguage')).toBe('ja-JP')
    expect(await loadVoiceRecognitionLanguage()).toBe('ja-JP')
  })

  it('reads Follow system when nothing is saved', async () => {
    const { loadVoiceRecognitionLanguage } = await fresh()
    expect(await loadVoiceRecognitionLanguage()).toBe(null)
  })

  it('reads Follow system for a stored value that is not a sane locale tag', async () => {
    stored.set('orca:voiceRecognitionLanguage', '')
    const empty = await fresh()
    expect(await empty.loadVoiceRecognitionLanguage()).toBe(null)
    stored.set('orca:voiceRecognitionLanguage', 'a'.repeat(36))
    const absurd = await fresh()
    expect(await absurd.loadVoiceRecognitionLanguage()).toBe(null)
  })

  it('saving Follow system removes the key and the next read follows the system again', async () => {
    const { saveVoiceRecognitionLanguage, loadVoiceRecognitionLanguage } = await fresh()
    await saveVoiceRecognitionLanguage('ja-JP')
    await saveVoiceRecognitionLanguage(null)
    expect(await loadVoiceRecognitionLanguage()).toBe(null)
    const reread = await fresh()
    expect(await reread.loadVoiceRecognitionLanguage()).toBe(null)
  })

  it('lets a save that arrives while the first read is failing win over Follow system', async () => {
    const { loadVoiceRecognitionLanguage, saveVoiceRecognitionLanguage } = await fresh()
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default
    let rejectRead: (error: Error) => void = () => {}
    AsyncStorage.getItem.mockImplementationOnce(
      () =>
        new Promise<string | null>((_resolve, reject) => {
          rejectRead = reject
        })
    )
    const loading = loadVoiceRecognitionLanguage()
    await saveVoiceRecognitionLanguage('ja-JP')
    rejectRead(new Error('storage unavailable'))
    expect(await loading).toBe('ja-JP')
  })
})

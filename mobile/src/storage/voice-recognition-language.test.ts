import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNativeSpeechServer, type NativeSpeechEngine } from '../platform/speech/native-speech'
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

// Each import is one bundle's evaluation of the module, as the shell's and the page's are on device;
// the mocked store is all they share, which is exactly the boundary a save has to cross.
async function fresh(): Promise<typeof VoiceRecognitionLanguage> {
  vi.resetModules()
  return await import('./voice-recognition-language')
}

// The device engine reads the stored choice through recognitionLocale; the fake stands in for native's recognizer.
function engineArmedBy(load: () => Promise<string | null>): NativeSpeechEngine {
  return {
    availability: async () => ({ status: 'ready', locale: 'en-US' }),
    start: async (locale) => ({ started: true, locale }),
    finish: async () => '',
    cancel: () => {},
    readPreference: async () => 'automatic',
    recognitionLocale: load,
    onText: () => {},
    onError: () => {}
  }
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
    vi.mocked(AsyncStorage.getItem).mockImplementationOnce(
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

  it('reads Follow system when storage fails twice in a row', async () => {
    const { loadVoiceRecognitionLanguage } = await fresh()
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default
    // Two rejections, not a standing one: the mock is shared across resetModules, so a standing one would poison the reads after this test.
    vi.mocked(AsyncStorage.getItem)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockRejectedValueOnce(new Error('storage unavailable'))
    expect(await loadVoiceRecognitionLanguage()).toBe(null)
  })
})

describe('a save and an arm across the context boundary', () => {
  beforeEach(() => {
    stored.clear()
    vi.resetModules()
  })

  it('shows a save from one module instance in the read of another, with no reset between', async () => {
    const writer = await fresh()
    const reader = await fresh()
    // Read once before any save: a reader that has never loaded would cross the boundary on first-read
    // luck, while the bug is a process-lifetime cache pinned to the pre-save choice.
    expect(await reader.loadVoiceRecognitionLanguage()).toBe(null)
    await writer.saveVoiceRecognitionLanguage('zh-CN')
    expect(await reader.loadVoiceRecognitionLanguage()).toBe('zh-CN')
    await writer.saveVoiceRecognitionLanguage(null)
    expect(await reader.loadVoiceRecognitionLanguage()).toBe(null)
    await writer.saveVoiceRecognitionLanguage('ja-JP')
    expect(await reader.loadVoiceRecognitionLanguage()).toBe('ja-JP')
  })

  it('arms the recognizer in what another instance saved, and follows the next switch without a reset', async () => {
    const writer = await fresh()
    const reader = await fresh()
    const server = createNativeSpeechServer(engineArmedBy(reader.loadVoiceRecognitionLanguage))
    // One arm before any save, so a process-lifetime cache in the reader is pinned to Follow system when
    // the save lands; arming from it afterwards is exactly the stale arm #31 observed.
    expect(await server.serve({ action: 'start', locale: 'en-US' })).toEqual({
      started: true,
      locale: 'en-US',
      reason: null
    })
    await writer.saveVoiceRecognitionLanguage('zh-CN')
    expect(await server.serve({ action: 'start', locale: 'en-US' })).toEqual({
      started: true,
      locale: 'zh-CN',
      reason: null
    })
    await writer.saveVoiceRecognitionLanguage(null)
    expect(await server.serve({ action: 'start', locale: 'en-US' })).toEqual({
      started: true,
      locale: 'en-US',
      reason: null
    })
    await writer.saveVoiceRecognitionLanguage('ja-JP')
    expect(await server.serve({ action: 'start', locale: 'en-US' })).toEqual({
      started: true,
      locale: 'ja-JP',
      reason: null
    })
  })
})

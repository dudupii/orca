import { describe, expect, it, vi } from 'vitest'
import { readoutLocaleResolver, readoutSpeakLocale } from './readout-speak-locale'

// The device-locale seam pulls expo-localization, which no vitest run defines; the resolver
// only needs a stable locale to fall back to.
vi.mock('../platform/speech/on-device-speech-locale', () => ({
  onDeviceSpeechLocale: vi.fn(() => 'en-US')
}))

describe('readoutSpeakLocale', () => {
  it('automatic probes the reply: han reads Chinese, kana reads Japanese', () => {
    const automatic = { mode: 'automatic' } as const
    expect(readoutSpeakLocale(automatic, '检查通过了,可以合并。', 'en-US')).toBe('zh-CN')
    expect(readoutSpeakLocale(automatic, 'チェックは通った。', 'en-US')).toBe('ja-JP')
    // Kana outranks han inside the probe, so Japanese prose borrowing ideographs stays Japanese.
    expect(readoutSpeakLocale(automatic, '日本語の文章です。', 'en-US')).toBe('ja-JP')
  })

  it('automatic keeps the device region when the device speaks the probed language', () => {
    const automatic = { mode: 'automatic' } as const
    expect(readoutSpeakLocale(automatic, '检查通过了。', 'zh-TW')).toBe('zh-TW')
    expect(readoutSpeakLocale(automatic, 'チェックは通った。', 'ja-JP')).toBe('ja-JP')
  })

  it('automatic falls to the device language when the script names none', () => {
    const automatic = { mode: 'automatic' } as const
    expect(readoutSpeakLocale(automatic, 'All checks pass, ready to merge.', 'de-DE')).toBe('de-DE')
    // Scripts the probe does not distinguish land on the device language too, not on a guess.
    expect(readoutSpeakLocale(automatic, '안녕하세요, 오류가 수정되었습니다', 'en-US')).toBe(
      'en-US'
    )
  })

  it('follow-system answers null, handing the language to the engine itself', () => {
    expect(readoutSpeakLocale({ mode: 'system' }, '检查通过了。', 'zh-CN')).toBeNull()
    expect(readoutSpeakLocale({ mode: 'system' }, 'All checks pass.', 'en-US')).toBeNull()
  })

  it('a chosen language answers itself, whatever the reply and the device speak', () => {
    const chosen = { mode: 'language', tag: 'fr-FR' } as const
    expect(readoutSpeakLocale(chosen, '检查通过了。', 'zh-CN')).toBe('fr-FR')
    expect(readoutSpeakLocale(chosen, 'All checks pass.', 'en-US')).toBe('fr-FR')
  })

  it('the loop-bound resolver reads the device locale per utterance', () => {
    expect(readoutLocaleResolver({ mode: 'automatic' })('检查通过了。')).toBe('zh-CN')
    expect(readoutLocaleResolver({ mode: 'automatic' })('All checks pass.')).toBe('en-US')
    expect(readoutLocaleResolver({ mode: 'system' })('All checks pass.')).toBeNull()
  })
})

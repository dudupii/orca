import { describe, expect, it } from 'vitest'
import { probeReadoutScriptLanguage } from './readout-script-language'

describe('probeReadoutScriptLanguage', () => {
  it('settles Japanese on kana, hiragana or katakana', () => {
    expect(probeReadoutScriptLanguage('チェックは通った。')).toBe('ja')
    expect(probeReadoutScriptLanguage('よろしくお願いします')).toBe('ja')
  })

  it('keeps kana ahead of han: Japanese prose that borrows ideographs stays Japanese', () => {
    expect(probeReadoutScriptLanguage('日本語の文章です。翻訳しました。')).toBe('ja')
  })

  it('settles Chinese on han with no kana anywhere', () => {
    expect(probeReadoutScriptLanguage('检查通过了,可以合并。')).toBe('zh')
    expect(probeReadoutScriptLanguage('混合 English words 的中文回复')).toBe('zh')
  })

  it('answers null for scripts it does not distinguish', () => {
    expect(probeReadoutScriptLanguage('안녕하세요, 오류가 수정되었습니다')).toBeNull()
    expect(probeReadoutScriptLanguage('Привет, всё готово')).toBeNull()
    expect(probeReadoutScriptLanguage('مرحبا، تم الإصلاح')).toBeNull()
  })

  it('answers null for prose with nothing script-like to read', () => {
    expect(probeReadoutScriptLanguage('All checks pass, ready to merge.')).toBeNull()
    expect(probeReadoutScriptLanguage('issue 50 fixed in a1b2c3')).toBeNull()
    expect(probeReadoutScriptLanguage('123 + 456 = ...?!')).toBeNull()
    expect(probeReadoutScriptLanguage('')).toBeNull()
  })
})

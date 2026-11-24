/**
 * The script probe both spoken-language decisions share: which language a readout's own text
 * points at when no locale was named for it. The wash expands an issue reference to sound native
 * to the prose it lands in; the speak chain picks the locale a lang-less reply is read aloud in.
 * One probe keeps those two decisions from drifting apart.
 *
 * Scripts the probe does not distinguish — hangul, Cyrillic, Arabic, any letters past ASCII
 * prose — answer null, and each caller gives that answer its own landing: the wash reads null
 * as English, the speak chain falls to the device's language.
 */

// Kana settles the language before han does: Japanese prose borrows ideographs, Chinese does not borrow kana.
const KANA = /[぀-ヿ]/
const IDEOGRAPH = /[一-鿿]/

/** The languages a readout's script alone can name; null when the script names none. */
export type ReadoutScriptLanguage = 'zh' | 'ja'

export function probeReadoutScriptLanguage(text: string): ReadoutScriptLanguage | null {
  if (KANA.test(text)) {
    return 'ja'
  }
  if (IDEOGRAPH.test(text)) {
    return 'zh'
  }
  return null
}

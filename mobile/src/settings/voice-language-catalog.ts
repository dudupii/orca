import { parseUiLocaleTag } from '../i18n/system-ui-locale'

// #31: the recognizer has no enumeration API, so the device list alone hid languages a bilingual user needed.
// A UI suggestion list only — a row the engine cannot serve still shows its own needs-download or unsupported
// answer, so the engine stays the guard, never the list.
export const VOICE_LANGUAGE_CATALOG_TAGS: readonly string[] = [
  'ar',
  'bn',
  'cs',
  'de',
  'el',
  'en',
  'es',
  'fa',
  'fi',
  'fr',
  'he',
  'hi',
  'hu',
  'id',
  'it',
  'ja-JP',
  'ko-KR',
  'ms',
  'nl',
  'pl',
  'pt-BR',
  'pt-PT',
  'ro',
  'ru',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh-CN',
  'zh-TW'
]

// BCP-47 is case-insensitive: a typed "zh-cn" is the catalog's zh-CN, one row, one check.
export function sameLocaleTag(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

// The pickers' whole language list: the device's preference list first, then a stored choice neither it nor the
// catalog spells (kept visible and checked), then the catalog. Exact duplicates fold case-insensitively, first
// spelling winning; a bare-language catalog entry (ja) folds under an earlier scriptless tag (the system's
// ja-JP), while script or region variants (zh-CN beside zh-TW, pt-BR beside pt-PT) never fold.
export function voiceLanguageCandidateTags(
  deviceTags: readonly string[],
  selected: string | null
): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  const scriptlessLanguages = new Set<string>()
  const push = (tag: string): void => {
    const key = tag.toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    tags.push(tag)
    const parts = parseUiLocaleTag(tag)
    if (parts !== null && parts.script === null) {
      scriptlessLanguages.add(parts.language.toLowerCase())
    }
  }
  for (const tag of deviceTags) {
    push(tag)
  }
  if (selected !== null) {
    push(selected)
  }
  for (const tag of VOICE_LANGUAGE_CATALOG_TAGS) {
    const parts = parseUiLocaleTag(tag)
    if (
      parts !== null &&
      parts.script === null &&
      parts.region === null &&
      scriptlessLanguages.has(parts.language.toLowerCase())
    ) {
      continue
    }
    push(tag)
  }
  return tags
}

// The bridge's locale schema bounds the tag at 35 characters; the shape is on us. See bridge-speech-verbs.ts.
export const SPEECH_LOCALE_MAX_LENGTH = 35

// The langtag shapes a user can mean: a 2-3 letter language (or 5-8 letter registered one), then optional
// script, region, variants, extensions and private use. Underscores are not BCP-47.
const SPEECH_LOCALE_TAG_PATTERN =
  /^(?:[a-z]{2,3}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-[a-z\d]{5,8}|\d[a-z\d]{3})*(?:-[0-9a-wy-z](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?$/i

// Returns the tag to store, or null when the text is not one; trims, because a pasted "zh-CN " is meant.
export function parseSpeechLocaleInput(text: string): string | null {
  const tag = text.trim()
  if (tag.length === 0 || tag.length > SPEECH_LOCALE_MAX_LENGTH) {
    return null
  }
  return SPEECH_LOCALE_TAG_PATTERN.test(tag) ? tag : null
}

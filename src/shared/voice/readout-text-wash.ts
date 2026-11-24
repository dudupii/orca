/**
 * The wash a spoken readout passes before it reaches the phone's TTS engine. Whatever authored
 * the readout — a model briefing or the condensed fallback — writes for a screen: bold markers
 * are spoken as "star star", a link is spoken as a thirty-character URL, `#50` is spoken as a
 * bare "number fifty". One pass sits between the speak boundary and the effect, turning that
 * markup into spoken prose. Every wording choice below is a hard-coded default for this first
 * version; no setting routes it.
 */

/** A markdown image is scaffolding twice over: its URL is unread and its alt text is not prose. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]*)\)/g

/** A markdown link keeps its readable text; the URL it wraps is never spoken. */
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]*)\)/g

/** A bare URL in prose, split into the space that introduced it and the URL itself. */
const BARE_URL = /( ?)(https?:\/\/\S+)/gi

// CJK sentence punctuation counts too: a Chinese line often glues `。` straight onto a URL.
const TRAILING_PUNCTUATION = /[.,;:!?)'"。！？，」』]+$/

/** Paired emphasis markers, strongest first so `***both***` peels in one step. */
const EMPHASIS_PAIRS: RegExp[] = [
  /\*\*\*(.+?)\*\*\*/g,
  /\*\*(.+?)\*\*/g,
  /\*(.+?)\*/g,
  /`([^`]*)`/g
]

/** An issue reference — digits only, so `## headings` and color hex with letters stay untouched. */
const ISSUE_REFERENCE = /#(\d+)\b/g

/** Kana settles the language before han does: Japanese prose borrows ideographs, Chinese does not borrow kana. */
const KANA = /[぀-ヿ]/
const IDEOGRAPH = /[一-鿿]/

type ReferenceLanguage = 'zh' | 'ja' | 'en'

/**
 * The language the issue reference expands in. The locale about to be spoken wins outright;
 * without one, the script of the readout itself is the only context left — and the reference
 * must sound native to the prose it lands in, not to a default locale.
 */
function referenceLanguage(lang: string | null | undefined, text: string): ReferenceLanguage {
  const spoken = (lang ?? '').toLowerCase()
  if (spoken.startsWith('zh')) {
    return 'zh'
  }
  if (spoken.startsWith('ja')) {
    return 'ja'
  }
  if (spoken) {
    return 'en'
  }
  if (KANA.test(text)) {
    return 'ja'
  }
  if (IDEOGRAPH.test(text)) {
    return 'zh'
  }
  return 'en'
}

/** The natural spoken form of issue `#50` in each language the wash distinguishes. */
function spokenIssueReference(number: string, language: ReferenceLanguage): string {
  if (language === 'zh') {
    return `${number} 号问题`
  }
  if (language === 'ja') {
    return `イシュー${number}`
  }
  return `issue ${number}`
}

/**
 * A bare URL is never read verbatim. A bare host is short enough to be worth its name — the
 * domain, with scheme and `www.` dropped. Anything deeper — a path, a query, a fragment like
 * `#issuecomment-…` — is anchor soup no listener wants: it is skipped whole, its context
 * presumably saying what it pointed at.
 */
function washBareUrl(url: string): string {
  const withoutScheme = url.replace(/^https?:\/\//i, '')
  const hostEnd = withoutScheme.search(/[/?#]/)
  // A bare trailing slash is still just a host; anything real after it makes the URL deep.
  if (hostEnd !== -1 && withoutScheme.slice(hostEnd) !== '/') {
    return ''
  }
  return withoutScheme.slice(0, hostEnd === -1 ? undefined : hostEnd).replace(/^www\./i, '')
}

/** Washes one readout: markup stripped, URLs named or dropped, `#50` said like a person would. */
export function washReadoutText(text: string, lang?: string | null): string {
  const withoutUrls = text
    .replace(MARKDOWN_IMAGE, '')
    .replace(MARKDOWN_LINK, '$1')
    .replace(BARE_URL, (_bare, introducer: string, url: string) => {
      // `introducer` is the space the URL rode in on, empty when the sentence opens with it: a
      // skipped URL takes that space along, a named domain keeps it.
      // The punctuation belongs to the sentence around the URL; keep it for the wash to see.
      const tail = url.match(TRAILING_PUNCTUATION)?.[0] ?? ''
      const washed = washBareUrl(url.slice(0, url.length - tail.length))
      return washed === '' ? tail : introducer + washed + tail
    })
  const withoutEmphasis = EMPHASIS_PAIRS.reduce(
    (carried, pair) => carried.replace(pair, '$1'),
    withoutUrls
  )
  const expanded = withoutEmphasis.replace(ISSUE_REFERENCE, (_match, number: string) =>
    spokenIssueReference(number, referenceLanguage(lang, text))
  )
  // Dropped URLs and peeled markers leave doubled blanks; TTS wants single-spaced prose.
  return expanded.replace(/[ \t]{2,}/g, ' ').trim()
}

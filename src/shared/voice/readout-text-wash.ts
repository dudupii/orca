/**
 * The wash a spoken readout passes before it reaches the phone's TTS engine. Whatever authored
 * the readout — a model briefing or the condensed fallback — writes for a screen: bold markers
 * are spoken as "star star", a link is spoken as a thirty-character URL, `#50` is spoken as a
 * bare "number fifty". One pass sits between the speak boundary and the effect, turning that
 * markup into spoken prose. Every wording choice below is a hard-coded default for this first
 * version; no setting routes it.
 */

import { PROSE_HTTP_URL_SOURCE } from '../prose-url-boundary'

/**
 * A markdown image is scaffolding twice over: its URL is unread and its alt text is not prose.
 * Both image and link destinations take an optional `<…>` wrap and title, as CommonMark spells
 * them; only the label is worth a listener's ear.
 */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s]*?)>?(?:\s+(?:'[^']*'|"[^"]*"|\([^)]*\)))?\s*\)/g
const MARKDOWN_LINK = /\[([^\]]+)\]\(\s*<?([^)\s]*?)>?(?:\s+(?:'[^']*'|"[^"]*"|\([^)]*\)))?\s*\)/g

/** An autolink is the same URL wearing `<` `>` — markup to strip before the bare-URL pass. */
const AUTOLINK = new RegExp(`<(${PROSE_HTTP_URL_SOURCE})>`, 'giu')

/** A bare URL in prose, split into the space that introduced it and the URL itself. */
const BARE_URL = new RegExp(`( ?)(${PROSE_HTTP_URL_SOURCE})`, 'giu')

/** Paired emphasis markers, strongest first so `***both***` peels in one step. */
const ASTERISK_PAIRS: RegExp[] = [
  /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g,
  /\*\*(?=\S)([\s\S]*?\S)\*\*/g,
  /\*(?=\S)([^*\s][^*]*?)\*/g
]

/**
 * Underscore emphasis only counts where CommonMark says it does: intraword `_` is a plain
 * character (snake_case identifiers survive), so the opener must not follow a letter or digit
 * and the closer must not lead into one. The captured pre-character stands in for a lookbehind,
 * which the mobile terminal WebView's WebKit cannot parse.
 */
const UNDERSCORE_PAIRS: RegExp[] = [
  /(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}])/gu,
  /(^|[^\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}])/gu
]

/** Inline code keeps its content and loses its ticks. */
const INLINE_CODE = /`([^`]*)`/g

/**
 * Prose also escapes the delimiters it wants spoken literally (`\*not bold\*`); the backslash is
 * markup too, but it must come off after the pairing passes, or the pairing would grab the
 * delimiters it freed. Each escape hides behind a private-use-wrapped placeholder no prose
 * carries.
 */
const ESCAPED_DELIMITER = /\\([\\`*_[\]()#])/g
const ESCAPE_HOLDER = /\uE000(\d+)\uE001/g

/**
 * An issue reference is digits after `#` — but so is a hex swatch, and length cannot tell
 * them apart: `#123456` is as good a ticket number as it is a gray. Context decides. A token
 * a color word leads straight into stays verbatim; everything else expands, whatever its
 * length. The word must be the last thing before the `#` (copulas and colons may bridge), so
 * "the palette bug in #50" still reads as a ticket.
 */
const ISSUE_REFERENCE = /#(\d+)\b/g
const COLOR_CONTEXT =
  /(?:^|[^\p{L}\p{N}])(?:palette|colou?r|background|foreground|fill|stroke|hex|颜色|色彩|配色|色值|背景色)\s*(?:is|was|are|=|:)?\s*$/iu

// Kana settles the language before han does: Japanese prose borrows ideographs, Chinese does not borrow kana.
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
 * hostname alone, with scheme, credentials, port and `www.` dropped, because a listener needs
 * the domain and nothing else. Anything deeper — a path, a query, a fragment like
 * `#issuecomment-…` — is anchor soup no listener wants: it is skipped whole, its context
 * presumably saying what it pointed at. A URL that will not parse is anchor soup too.
 */
function washBareUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return ''
  }
  // A bare trailing slash is still just a host; anything real after it makes the URL deep.
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return ''
  }
  return spokenHost(url)
}

/**
 * The host a listener hears, taken from the text the URL was matched with rather than from
 * the parsed URL. The parser serializes a Unicode host into punycode — `https://例え.jp` would
 * come back as `xn--r8jz45g.jp`, machine soup no reader asked for — so the parser only decides
 * whether the URL is worth hearing at all; the spoken form keeps the characters its author
 * wrote, minus credentials, port and `www.`.
 */
function spokenHost(url: string): string {
  const afterScheme = url.replace(/^https?:\/\//i, '')
  // The authority ends where a path, query or fragment would begin; the bounded match carries
  // no whitespace past it.
  const authority = afterScheme.split(/[/?#]/)[0] ?? ''
  // Userinfo cannot hold a raw `@`, so the last one separates it from the host.
  const at = authority.lastIndexOf('@')
  const hostPort = at === -1 ? authority : authority.slice(at + 1)
  // A bracketed IPv6 host ends at its `]`; whatever follows is the port.
  const bareHost = hostPort.startsWith('[')
    ? hostPort.slice(0, hostPort.indexOf(']') + 1)
    : hostPort.replace(/:\d*$/, '')
  const named = bareHost.replace(/^www\./i, '')
  // A listener hears the same domain however it is cased, and lowercasing keeps mixed-case
  // prose calm; a Unicode host, though, must not pass through case mapping, which can quietly
  // rewrite it — so only an all-ASCII domain normalizes.
  return /^[\x21-\x7e]*$/.test(named) ? named.toLowerCase() : named
}

/** Peels each paired delimiter, keeping whatever the pair's capture groups held. */
function peelPairs(text: string, pairs: RegExp[]): string {
  return pairs.reduce(
    (carried, pair) =>
      carried.replace(pair, (_match, ...groups: (string | undefined)[]) =>
        groups
          .slice(0, -2)
          .filter((group) => group !== undefined)
          .join('')
      ),
    text
  )
}

/** Washes one readout: markup stripped, URLs named or dropped, `#50` said like a person would. */
export function washReadoutText(text: string, lang?: string | null): string {
  // Escaped delimiters sit out the pairing passes, then come back without their backslash.
  const escapes: string[] = []
  const stashed = text.replace(ESCAPED_DELIMITER, (_escape, delimiter: string) => {
    escapes.push(delimiter)
    return `\uE000${escapes.length - 1}\uE001`
  })
  // Emphasis peels before the URL passes: a URL wearing bold is still just a URL, and peeling
  // after would leave the markers stranded around the washed-out address.
  const withoutEmphasis = peelPairs(peelPairs(stashed, ASTERISK_PAIRS), UNDERSCORE_PAIRS).replace(
    INLINE_CODE,
    '$1'
  )
  const withoutImages = withoutEmphasis.replace(MARKDOWN_IMAGE, '')
  const withoutLinks = withoutImages
    .replace(AUTOLINK, (_autolink, url: string) => washBareUrl(url))
    .replace(MARKDOWN_LINK, '$1')
    .replace(BARE_URL, (_bare, introducer: string, url: string) => {
      // `introducer` is the space the URL rode in on, empty when the sentence opens with it: a
      // skipped URL takes that space along, a named domain keeps it.
      const washed = washBareUrl(url)
      return washed === '' ? '' : introducer + washed
    })
  const expanded = withoutLinks.replace(ISSUE_REFERENCE, (match, number: string, offset: number) =>
    COLOR_CONTEXT.test(withoutLinks.slice(0, offset))
      ? match
      : spokenIssueReference(number, referenceLanguage(lang, text))
  )
  // Dropped URLs and peeled markers leave doubled blanks; TTS wants single-spaced prose.
  const spaced = expanded.replace(/[ \t]{2,}/g, ' ').trim()
  return spaced.replace(ESCAPE_HOLDER, (_holder, index: string) => escapes[Number(index)] ?? '')
}

import { routeNativeChatHref } from '../../../src/shared/native-chat-href-routing'
import { openExternalLink } from '../platform/external-link'
import { isExternalMarkdownImageSrc } from '../session/markdown-relative-image-srcs'

export type MarkdownHrefRoute =
  | { kind: 'web'; url: string }
  | { kind: 'file'; pathText: string }
  | { kind: 'none' }

function withLineSuffix(pathText: string, line: number | null): string {
  return line === null ? pathText : `${pathText}:${line}`
}

export function routeMarkdownHref(href: string): MarkdownHrefRoute {
  const route = routeNativeChatHref(href)
  if (route.kind !== 'file') {
    return route
  }
  return { kind: 'file', pathText: withLineSuffix(route.pathText, route.line) }
}

// Web/mail hrefs open the system handler; file-target hrefs (file: URIs and
// scheme-less paths — the entire desktop file-link contract) go to onOpenFile.
export function openMarkdownHref(href: string, onOpenFile?: (pathText: string) => void): void {
  const route = routeMarkdownHref(href)
  if (route.kind === 'web') {
    // The seam, not react-native's `Linking`: inside the shell's WebView `openURL`
    // resolves without opening anything.
    openExternalLink(route.url)
    return
  }
  if (route.kind === 'file' && onOpenFile) {
    onOpenFile(route.pathText)
  }
}

// The dedicated src-keyed handler owns image taps; external srcs route as web hrefs.
export function openMarkdownImage(
  rawSrc: string,
  onOpenFile?: (pathText: string) => void,
  onOpenImage?: (rawSrc: string) => void
): void {
  if (onOpenImage && !isExternalMarkdownImageSrc(rawSrc)) {
    onOpenImage(rawSrc)
    return
  }
  openMarkdownHref(rawSrc, onOpenFile)
}

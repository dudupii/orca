import {
  createMobileFilePreviewHref,
  displayNameFromPreviewPath
} from '../files/mobile-file-preview-route'
import {
  isExternalMarkdownImageSrc,
  resolveMarkdownRelativeImagePath
} from './markdown-relative-image-srcs'

export type MarkdownImageTapTarget = {
  hostId: string
  worktreeId: string
  worktreeName?: string
}

/**
 * The zoomable image-preview href for a tapped markdown image, resolved against the document's
 * worktree-relative path — or null when the src has no worktree file behind it (external URL,
 * anchor-only src, or a climb out of the worktree).
 */
export function markdownImageTapPreviewHref(
  rawSrc: string,
  markdownRelativePath: string,
  target: MarkdownImageTapTarget
): ReturnType<typeof createMobileFilePreviewHref> | null {
  if (isExternalMarkdownImageSrc(rawSrc)) {
    return null
  }
  const relativePath = resolveMarkdownRelativeImagePath(rawSrc, markdownRelativePath)
  if (!relativePath) {
    return null
  }
  return createMobileFilePreviewHref({
    hostId: target.hostId,
    worktreeId: target.worktreeId,
    source: 'worktree',
    relativePath,
    name: displayNameFromPreviewPath(relativePath),
    ...(target.worktreeName ? { worktreeName: target.worktreeName } : {})
  })
}

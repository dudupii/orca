import { describe, expect, it } from 'vitest'
import { markdownImageTapPreviewHref } from './markdown-image-tap-preview'

const target = { hostId: 'host-a', worktreeId: 'wt-1', worktreeName: 'develop' }

describe('markdownImageTapPreviewHref', () => {
  it('resolves a relative src against the markdown document and builds the preview route', () => {
    expect(markdownImageTapPreviewHref('images/shot.png', 'docs/list.md', target)).toEqual({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'host-a',
        worktreeId: 'wt-1',
        source: 'worktree',
        relativePath: 'docs/images/shot.png',
        name: 'shot.png',
        worktreeName: 'develop'
      }
    })
  })

  it('drops the query and fragment before resolving', () => {
    expect(markdownImageTapPreviewHref('a.png?v=2#x', 'docs/list.md', target)).toEqual({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'host-a',
        worktreeId: 'wt-1',
        source: 'worktree',
        relativePath: 'docs/a.png',
        name: 'a.png',
        worktreeName: 'develop'
      }
    })
  })

  it('omits worktreeName when the target carries none', () => {
    const href = markdownImageTapPreviewHref('shot.png', 'README.md', {
      hostId: 'host-a',
      worktreeId: 'wt-1'
    })
    expect(href).toEqual({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'host-a',
        worktreeId: 'wt-1',
        source: 'worktree',
        relativePath: 'shot.png',
        name: 'shot.png'
      }
    })
  })

  it('answers null for an external URL, a protocol-relative src, and a worktree climb-out', () => {
    expect(markdownImageTapPreviewHref('https://example.com/a.png', 'docs/list.md', target)).toBe(
      null
    )
    expect(markdownImageTapPreviewHref('//cdn.example.com/a.png', 'docs/list.md', target)).toBe(
      null
    )
    expect(markdownImageTapPreviewHref('../../../outside.png', 'docs/list.md', target)).toBe(null)
  })

  it('answers null for an anchor-only or empty src', () => {
    expect(markdownImageTapPreviewHref('#frag', 'docs/list.md', target)).toBe(null)
    expect(markdownImageTapPreviewHref('', 'docs/list.md', target)).toBe(null)
  })
})

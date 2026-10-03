import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ImageReadArgs = [client: unknown, worktreeId: string, relativePath: string, content: string]

const seams = vi.hoisted(
  (): {
    client: { sendRequest: () => void }
    imageReads: ImageReadArgs[]
    imageSources: Record<string, string>
    markdownPreviewProps: Array<{ imageSources?: Record<string, string> }>
  } => ({
    client: { sendRequest: () => {} },
    imageReads: [],
    imageSources: {},
    markdownPreviewProps: []
  })
)

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Image: 'Image',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Save: 'Icon' }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: () => {}, canGoBack: () => false })
}))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./MobileFilePreviewSourceText', () => ({
  MobileFilePreviewSourceText: () => null
}))
vi.mock('./MobileFileMediaHandoff', () => ({ MobileFileMediaHandoff: () => null }))
vi.mock('./MobileFileMarkdownPreview', () => ({
  MobileFileMarkdownPreview: (props: { imageSources?: Record<string, string> }) => {
    seams.markdownPreviewProps.push(props)
    return null
  }
}))
vi.mock('../transport/client-context', () => ({
  useForceReconnect: () => null,
  useHostClient: () => ({ client: seams.client, state: 'connected', clientId: null })
}))
vi.mock('./mobile-file-preview-request', () => ({
  loadMobileFilePreview: () =>
    Promise.resolve({
      status: 'ready',
      kind: 'markdown',
      content: '# Doc\n\n![shot](images/shot.png)',
      truncated: false,
      byteLength: 29
    }),
  previewError: (message: string) => ({ status: 'error', message, reconnect: false }),
  saveMobileTerminalArtifactPreview: () => Promise.resolve({ status: 'saved' })
}))
vi.mock('../session/markdown-relative-image-srcs', () => ({
  readMarkdownImageSources: (...args: ImageReadArgs) => {
    seams.imageReads.push(args)
    return Promise.resolve(seams.imageSources)
  }
}))

import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'

const WORKTREE_ROUTE = {
  ok: true,
  params: { hostId: 'host-a', worktreeId: 'wt-1', relativePath: 'docs/list.md' }
} as const

const ARTIFACT_ROUTE = {
  ok: true,
  params: {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    source: 'terminalArtifact',
    absolutePath: '/tmp/orca/artifact.md',
    grantId: 'grant-1'
  }
} as const

describe('the file preview markdown image resolution', () => {
  let tree: ReactTestRenderer | null = null

  beforeEach(() => {
    seams.imageReads = []
    seams.imageSources = {}
    seams.markdownPreviewProps = []
  })

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  async function render(route: typeof WORKTREE_ROUTE | typeof ARTIFACT_ROUTE): Promise<void> {
    await act(async () => {
      tree = create(createElement(MobileFilePreviewScreen, { route }))
    })
    // Let the preview load, then the image-read effect, then its state settle.
    await act(async () => {})
  }

  it('reads a ready worktree markdown document and forwards the resolved sources', async () => {
    seams.imageSources = { 'images/shot.png': 'data:image/png;base64,AAA' }
    await render(WORKTREE_ROUTE)

    expect(seams.imageReads).toEqual([
      [seams.client, 'wt-1', 'docs/list.md', '# Doc\n\n![shot](images/shot.png)']
    ])
    expect(seams.markdownPreviewProps.at(-1)?.imageSources).toEqual({
      'images/shot.png': 'data:image/png;base64,AAA'
    })
  })

  it('never reads images for a terminal-artifact markdown document', async () => {
    await render(ARTIFACT_ROUTE)

    expect(seams.imageReads).toEqual([])
  })
})

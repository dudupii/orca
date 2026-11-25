import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNetRequestFetchAdapter } from '../testing/updater-net-request.fixture'

const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_ARCH = process.arch

const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock, request: netRequestMock }
}))

function buildAtomFeed(tags: string[], updatedAt: Record<string, string> = {}): string {
  const entries = tags
    .map(
      (tag) =>
        `<entry>${updatedAt[tag] ? `<updated>${updatedAt[tag]}</updated>` : ''}<link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${entries}</feed>`
}

function buildManifest(tag: string): string {
  const version = tag.replace(/^v/i, '')
  return [
    `version: ${version}`,
    'files:',
    `  - url: Orca-${version}-arm64-mac.zip`,
    '    sha512: test',
    `path: Orca-${version}-arm64-mac.zip`
  ].join('\n')
}

function respondWithAtom(
  tags: string[],
  missingManifestTags: string[] = [],
  missingAssetTags: string[] = [],
  unavailableManifestTags: string[] = [],
  updatedAt: Record<string, string> = {}
): void {
  const missingManifests = new Set(missingManifestTags)
  const missingAssets = new Set(missingAssetTags)
  const unavailableManifests = new Set(unavailableManifestTags)
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(buildAtomFeed(tags, updatedAt))
      })
    }

    const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z0-9-]+)?\.yml$/)
    if (manifestMatch) {
      const tag = decodeURIComponent(manifestMatch[1])
      if (unavailableManifests.has(tag)) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve('')
        })
      }
      return Promise.resolve({
        ok: !missingManifests.has(tag),
        status: missingManifests.has(tag) ? 404 : 200,
        text: () => Promise.resolve(buildManifest(tag))
      })
    }

    const assetMatch = url.match(/\/releases\/download\/([^/]+)\/(.+)$/)
    if (assetMatch && init?.method === 'HEAD') {
      return Promise.resolve({
        ok: !missingAssets.has(decodeURIComponent(assetMatch[1])),
        status: missingAssets.has(decodeURIComponent(assetMatch[1])) ? 404 : 200,
        text: () => Promise.resolve('')
      })
    }

    return Promise.resolve({
      ok: false,
      text: () => Promise.resolve('')
    })
  })
}

function setPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

function setArchForTest(arch: NodeJS.Architecture): void {
  Object.defineProperty(process, 'arch', { value: arch })
}

describe('fetchNewerReleaseTag', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  afterEach(() => {
    setPlatformForTest(ORIGINAL_PLATFORM)
    setArchForTest(ORIGINAL_ARCH)
  })

  it('reports not-ready with last-good when newer platform updater manifests are missing', async () => {
    respondWithAtom(
      ['v1.4.1-rc.4', 'v1.4.1-rc.3', 'v1.4.1-rc.2', 'v1.4.1-rc.1'],
      ['v1.4.1-rc.4', 'v1.4.1-rc.3']
    )

    const { fetchNewerReleaseTag, fetchNewerReleaseTagsWithReadiness } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.1-rc.1')).toBeNull()
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.1-rc.1', 2)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.1-rc.2'
    })
  })

  it('reports manifest transport failures as unavailable', async () => {
    respondWithAtom(['v1.4.2'], [], [], ['v1.4.2'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.0', 1)).resolves.toEqual({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'manifest'
    })
  })

  it('reports not-ready with last-good when newer manifest assets are not reachable yet', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2', 'v1.4.1'], [], ['v1.4.3'])

    const { fetchNewerReleaseTag, fetchNewerReleaseTagsWithReadiness } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.0')).toBeNull()
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.0', 1)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.2'
    })
  })

  it('does not return the current tag as the primary update when newer manifests are missing', async () => {
    respondWithAtom(['v1.4.1-rc.3', 'v1.4.1-rc.2', 'v1.4.1-rc.1'], ['v1.4.1-rc.3', 'v1.4.1-rc.2'])

    const { fetchNewerReleaseTag, fetchNewerReleaseTags } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.1-rc.1')).toBeNull()
    expect(await fetchNewerReleaseTags('1.4.1-rc.1', 2)).toEqual([])
  })

  it('probes a bounded manifest window concurrently', async () => {
    const feedTags = [
      'v1.4.8-rc.0',
      'v1.4.7-rc.0',
      'v1.4.6-rc.0',
      'v1.4.5-rc.0',
      'v1.4.4-rc.0',
      'v1.4.3-rc.0',
      'v1.4.2-rc.0',
      'v1.4.1-rc.0'
    ]
    const manifestUrls: string[] = []
    const manifestResolvers: (() => void)[] = []

    netFetchMock.mockImplementation((url: string) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(buildAtomFeed(feedTags))
        })
      }

      manifestUrls.push(url)
      return new Promise((resolve) => {
        manifestResolvers.push(() => {
          resolve({ ok: false, text: () => Promise.resolve('') })
        })
      })
    })

    const { fetchNewerReleaseTags } = await import('./updater-prerelease-feed')
    const result = fetchNewerReleaseTags('1.4.0-rc.0', 2)

    await vi.waitFor(() => {
      expect(manifestUrls).toHaveLength(6)
    })
    expect(manifestResolvers).toHaveLength(6)

    for (const resolveManifest of manifestResolvers) {
      resolveManifest()
    }

    await expect(result).resolves.toEqual([])
    expect(netFetchMock).toHaveBeenCalledTimes(7)
  })
})

describe('personal-channel feed', () => {
  const PERSONAL_ATOM_URL = 'https://github.com/dudupii/orca/releases.atom'
  const T1 = '2026-11-20T10:00:00Z'
  const T2 = '2026-11-21T10:00:00Z'
  const T3 = '2026-11-22T10:00:00Z'

  function buildPersonalAtomFeed(tags: string[], updatedAt: Record<string, string> = {}): string {
    const entries = tags
      .map(
        (tag) =>
          `<entry>${updatedAt[tag] ? `<updated>${updatedAt[tag]}</updated>` : ''}<link rel="alternate" type="text/html" href="https://github.com/dudupii/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
      )
      .join('')
    return `<?xml version="1.0" encoding="UTF-8"?><feed>${entries}</feed>`
  }

  /** Serve the fork repo's feed plus generic manifest/asset HEAD responders (repo-agnostic paths). */
  function respondWithPersonalAtom(
    tags: string[],
    updatedAt: Record<string, string>,
    missingManifestTags: string[] = []
  ): void {
    const missingManifests = new Set(missingManifestTags)
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === PERSONAL_ATOM_URL) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(buildPersonalAtomFeed(tags, updatedAt))
        })
      }

      const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z0-9-]+)?\.yml$/)
      if (manifestMatch) {
        const tag = decodeURIComponent(manifestMatch[1])
        const missing = missingManifests.has(tag)
        return Promise.resolve({
          ok: !missing,
          status: missing ? 404 : 200,
          text: () => Promise.resolve(buildManifest(tag))
        })
      }

      const assetMatch = url.match(/\/releases\/download\/([^/]+)\/(.+)$/)
      if (assetMatch && init?.method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
      }

      return Promise.resolve({ ok: false, text: () => Promise.resolve('') })
    })
  }

  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  afterEach(() => {
    setPlatformForTest(ORIGINAL_PLATFORM)
    setArchForTest(ORIGINAL_ARCH)
  })

  it('reads the fork feed and offers a release published after the installed one', async () => {
    respondWithPersonalAtom(['personal-1.4.215-5f6e7d8c9', 'personal-1.4.214-4e2f1a0b3'], {
      'personal-1.4.215-5f6e7d8c9': T3,
      'personal-1.4.214-4e2f1a0b3': T1
    })
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.214-4e2f1a0b3')).toBe('personal-1.4.215-5f6e7d8c9')
    expect(netFetchMock).toHaveBeenCalledWith(PERSONAL_ATOM_URL, expect.anything())
  })

  it('never re-offers the installed tag even when it is the newest entry', async () => {
    respondWithPersonalAtom(['personal-1.4.214-4e2f1a0b3'], {
      'personal-1.4.214-4e2f1a0b3': T3
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTagsWithReadiness('1.4.214-4e2f1a0b3', 1)).toMatchObject({
      tags: [],
      state: 'no-newer'
    })
  })

  it('does not offer a release older than the installed one', async () => {
    respondWithPersonalAtom(['personal-1.4.214-4e2f1a0b3', 'personal-1.4.215-5f6e7d8c9'], {
      'personal-1.4.214-4e2f1a0b3': T3,
      'personal-1.4.215-5f6e7d8c9': T1
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTagsWithReadiness('1.4.214-4e2f1a0b3', 1)).toMatchObject({
      tags: [],
      state: 'no-newer'
    })
  })

  it('prefers build order over semver for same-base rebuilds', async () => {
    // 111112222 sorts below fffff9999 in semver but was published later; recency must win.
    respondWithPersonalAtom(['personal-1.4.214-fffff9999', 'personal-1.4.214-111112222'], {
      'personal-1.4.214-fffff9999': T1,
      'personal-1.4.214-111112222': T3
    })
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.214-fffff9999')).toBe('personal-1.4.214-111112222')
  })

  it('offers the newest entry when the installed release has aged out of the feed', async () => {
    respondWithPersonalAtom(['personal-1.4.215-5f6e7d8c9', 'personal-1.4.216-0a1b2c3d4'], {
      'personal-1.4.215-5f6e7d8c9': T1,
      'personal-1.4.216-0a1b2c3d4': T2
    })
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.214-4e2f1a0b3')).toBe('personal-1.4.216-0a1b2c3d4')
  })

  it('ignores stray non-personal tags on the fork feed', async () => {
    respondWithPersonalAtom(['v1.4.999', 'personal-1.4.215-5f6e7d8c9'], {
      'v1.4.999': T3,
      'personal-1.4.215-5f6e7d8c9': T2
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    const result = await fetchNewerReleaseTagsWithReadiness('1.4.213-123456789', 5)
    expect(result.tags).toEqual(['personal-1.4.215-5f6e7d8c9'])
    // The stable tag must not have been probed for readiness.
    const probedUrls = netFetchMock.mock.calls.map(([url]) => String(url))
    expect(probedUrls.some((url) => url.includes('/releases/download/v1.4.999/'))).toBe(false)
  })

  it('probes personal manifests against the fork download base', async () => {
    respondWithPersonalAtom(['personal-1.4.215-5f6e7d8c9', 'personal-1.4.214-4e2f1a0b3'], {
      'personal-1.4.215-5f6e7d8c9': T2,
      'personal-1.4.214-4e2f1a0b3': T1
    })
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    const { getReleaseDownloadUrl } = await import('./updater-release-readiness')

    expect(await fetchNewerReleaseTag('1.4.214-4e2f1a0b3')).toBe('personal-1.4.215-5f6e7d8c9')
    expect(getReleaseDownloadUrl('personal-1.4.215-5f6e7d8c9')).toBe(
      'https://github.com/dudupii/orca/releases/download/personal-1.4.215-5f6e7d8c9'
    )
    expect(getReleaseDownloadUrl('v1.4.215')).toBe(
      'https://github.com/stablyai/orca/releases/download/v1.4.215'
    )
    const probedUrls = netFetchMock.mock.calls.map(([url]) => String(url))
    expect(probedUrls).toContainEqual(
      expect.stringMatching(
        /^https:\/\/github\.com\/dudupii\/orca\/releases\/download\/personal-1\.4\.215-5f6e7d8c9\/latest(-linux|-mac)?\.yml$/
      )
    )
  })

  it('holds a fresh personal release behind the update delay like the official channel', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const NOW = Date.parse('2026-11-23T12:00:00Z')
    respondWithPersonalAtom(
      ['personal-1.4.215-5f6e7d8c9', 'personal-1.4.214-9aaa00001'],
      {
        'personal-1.4.215-5f6e7d8c9': new Date(NOW - DAY_MS).toISOString(),
        'personal-1.4.214-9aaa00001': new Date(NOW - 8 * DAY_MS).toISOString()
      },
      ['personal-1.4.214-9aaa00001']
    )
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    const result = await fetchNewerReleaseTagsWithReadiness('1.4.214-4e2f1a0b3', 1, {
      minReleaseAgeMs: 7 * DAY_MS,
      now: NOW
    })
    expect(result.releaseDelay?.heldRelease?.tag).toBe('personal-1.4.215-5f6e7d8c9')
    // The aged release has no manifest, so nothing installable is offered.
    expect(result.tags).toEqual([])
  })

  it('never consults the fork feed for official versions', async () => {
    respondWithAtom(['v1.4.2'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.1')).toBe('v1.4.2')
    const fetchedUrls = netFetchMock.mock.calls.map(([url]) => String(url))
    expect(fetchedUrls).not.toContain(PERSONAL_ATOM_URL)
  })
})

describe('fetchNewerReleaseTagsWithReadiness update delay', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const NOW = Date.parse('2026-11-02T12:00:00Z')
  const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString()
  const delay = { includePrerelease: false, minReleaseAgeMs: 7 * DAY_MS, now: NOW }

  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  it('offers the newest release past the delay and reports the newer one it holds', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2', 'v1.4.1'], [], [], [], {
      'v1.4.3': daysAgo(1),
      'v1.4.2': daysAgo(8),
      'v1.4.1': daysAgo(20)
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result.tags).toEqual(['v1.4.2'])
    expect(result.releaseDelay?.heldRelease).toEqual({
      tag: 'v1.4.3',
      version: '1.4.3',
      releasedAt: NOW - DAY_MS
    })
  })

  it('holds everything when every newer release is inside the delay', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2'], [], [], [], {
      'v1.4.3': daysAgo(1),
      'v1.4.2': daysAgo(3)
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result).toMatchObject({ tags: [], state: 'no-newer' })
    expect(result.releaseDelay?.heldRelease?.tag).toBe('v1.4.3')
  })

  it('fails closed for releases without a feed timestamp', async () => {
    respondWithAtom(['v1.4.2'])
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result.tags).toEqual([])
    expect(result.releaseDelay?.heldRelease).toEqual({
      tag: 'v1.4.2',
      version: '1.4.2',
      releasedAt: null
    })
  })
})

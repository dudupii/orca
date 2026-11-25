import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createPersonalReleaseUpdateSource,
  parsePersonalReleases
} from './personal-release-update-source'

// Recorded once from the live endpoints on 2026-11-25, unedited. The list is the first two entries
// (`?per_page=2`): a full page of release objects would outweigh the tests it feeds, and the two
// entries carry every shape the flow reads.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}
const releasesPage = fixture('github-personal-releases.json')
const release520 = fixture('github-release-personal-1.4.214-520cdf128.json')

const RELEASES_URL = 'https://api.github.com/repos/dudupii/orca/releases'
const releaseTagUrl = (tag: string) =>
  `https://api.github.com/repos/dudupii/orca/releases/tags/${tag}`

/** A clone of the recorded release with the given fields replaced; a renamed tag's page URL follows it. */
function releaseClone(overrides: Record<string, unknown>): Record<string, unknown> {
  const htmlUrl =
    typeof overrides.tag_name === 'string' && overrides.html_url === undefined
      ? `https://github.com/dudupii/orca/releases/tag/${overrides.tag_name}`
      : undefined
  return {
    ...Object(release520),
    ...overrides,
    ...(htmlUrl === undefined ? {} : { html_url: htmlUrl })
  }
}

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const requested: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    const route = routes[url]
    if (!route) {
      throw new Error(`unexpected request ${url}`)
    }
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status })
  }
  return { fetchImpl, requested }
}

const signal = new AbortController().signal

describe('personal releases feed parsing', () => {
  it('keeps the published APK releases from the recorded page', () => {
    expect(parsePersonalReleases(releasesPage)).toEqual([
      {
        tag: 'personal-1.4.214-520cdf128',
        createdAt: '2026-11-24T22:33:08Z',
        pageUrl: 'https://github.com/dudupii/orca/releases/tag/personal-1.4.214-520cdf128'
      },
      {
        tag: 'personal-1.4.214-3b51e62d1',
        createdAt: '2026-11-23T05:35:22Z',
        pageUrl: 'https://github.com/dudupii/orca/releases/tag/personal-1.4.214-3b51e62d1'
      }
    ])
  })

  it('drops drafts, APK-less builds, and malformed entries without losing the rest', () => {
    // personal-1.4.214-50541eadb is a real release whose workflow build never attached an APK.
    const parsed = parsePersonalReleases([
      releaseClone({ draft: true }),
      releaseClone({
        tag_name: 'personal-1.4.214-50541eadb',
        assets: [{ name: 'orca-linux.AppImage' }]
      }),
      releaseClone({ tag_name: 42 }),
      releaseClone({ tag_name: 'personal-1.4.214-3b51e62d1' })
    ])
    expect(parsed.map((release) => release.tag)).toEqual(['personal-1.4.214-3b51e62d1'])
  })

  it('rejects a payload that is not a release list', () => {
    expect(() => parsePersonalReleases({ message: 'Not Found' })).toThrow()
  })
})

describe('personal release source (Android sideload of the fork)', () => {
  it('offers the newest release built after the installed tag', async () => {
    const installed = releaseClone({
      tag_name: 'personal-1.4.214-3b51e62d1',
      created_at: '2026-11-23T05:35:22Z'
    })
    const { fetchImpl } = fakeFetch({
      [releaseTagUrl('personal-1.4.214-3b51e62d1')]: { status: 200, body: installed },
      [RELEASES_URL]: { status: 200, body: releasesPage }
    })
    await expect(
      createPersonalReleaseUpdateSource(fetchImpl).check('personal-1.4.214-3b51e62d1', signal)
    ).resolves.toEqual({
      kind: 'available',
      version: 'personal-1.4.214-520cdf128',
      url: 'https://github.com/dudupii/orca/releases/tag/personal-1.4.214-520cdf128'
    })
  })

  it('returns current when the installed tag is the newest release', async () => {
    const { fetchImpl, requested } = fakeFetch({
      [releaseTagUrl('personal-1.4.214-520cdf128')]: { status: 200, body: release520 },
      [RELEASES_URL]: { status: 200, body: releasesPage }
    })
    await expect(
      createPersonalReleaseUpdateSource(fetchImpl).check('personal-1.4.214-520cdf128', signal)
    ).resolves.toEqual({ kind: 'current' })
    expect(requested).toEqual([releaseTagUrl('personal-1.4.214-520cdf128'), RELEASES_URL])
  })

  it('returns current when only older personal releases exist', async () => {
    const { fetchImpl } = fakeFetch({
      [releaseTagUrl('personal-1.4.214-520cdf128')]: { status: 200, body: release520 },
      [RELEASES_URL]: {
        status: 200,
        body: [
          releaseClone({
            tag_name: 'personal-1.4.214-3b51e62d1',
            created_at: '2026-11-23T05:35:22Z'
          })
        ]
      }
    })
    await expect(
      createPersonalReleaseUpdateSource(fetchImpl).check('personal-1.4.214-520cdf128', signal)
    ).resolves.toEqual({ kind: 'current' })
  })

  it('returns current without listing releases when the installed tag has none', async () => {
    const { fetchImpl, requested } = fakeFetch({
      [releaseTagUrl('personal-1.4.214-3b51e62d1')]: { status: 404 }
    })
    await expect(
      createPersonalReleaseUpdateSource(fetchImpl).check('personal-1.4.214-3b51e62d1', signal)
    ).resolves.toEqual({ kind: 'current' })
    expect(requested).toEqual([releaseTagUrl('personal-1.4.214-3b51e62d1')])
  })

  it('picks build order from created_at, not GitHub publish-ordered list position', async () => {
    // GitHub lists releases by publish time: 8a35b917a precedes 210f332f0 even though it was created first.
    const { fetchImpl } = fakeFetch({
      [releaseTagUrl('personal-1.4.214-cacb2f875')]: {
        status: 200,
        body: releaseClone({
          tag_name: 'personal-1.4.214-cacb2f875',
          created_at: '2026-10-04T07:43:00Z'
        })
      },
      [RELEASES_URL]: {
        status: 200,
        body: [
          releaseClone({
            tag_name: 'personal-1.4.214-8a35b917a',
            created_at: '2026-10-05T00:09:41Z'
          }),
          releaseClone({
            tag_name: 'personal-1.4.214-210f332f0',
            created_at: '2026-10-05T03:25:55Z'
          })
        ]
      }
    })
    await expect(
      createPersonalReleaseUpdateSource(fetchImpl).check('personal-1.4.214-cacb2f875', signal)
    ).resolves.toEqual({
      kind: 'available',
      version: 'personal-1.4.214-210f332f0',
      url: 'https://github.com/dudupii/orca/releases/tag/personal-1.4.214-210f332f0'
    })
  })

  it('ignores non-personal releases and entries without a build order', async () => {
    const { fetchImpl } = fakeFetch({
      [releaseTagUrl('personal-1.4.214-3b51e62d1')]: {
        status: 200,
        body: releaseClone({
          tag_name: 'personal-1.4.214-3b51e62d1',
          created_at: '2026-09-21T04:04:36Z'
        })
      },
      [RELEASES_URL]: {
        status: 200,
        body: [
          // A real APK release in the fork that is not a personal release; its timestamp is
          // lifted past the installed tag so a missing prefix filter would offer it.
          releaseClone({
            tag_name: 'mobile-android-v0.0.48-slash-commands.3',
            created_at: '2026-11-25T00:00:00Z'
          }),
          releaseClone({ tag_name: 'personal-1.4.214-50541eadb', created_at: 'not-a-date' }),
          releaseClone({
            tag_name: 'personal-1.4.214-8bdaf574f',
            created_at: '2026-09-21T04:04:36Z'
          })
        ]
      }
    })
    await expect(
      createPersonalReleaseUpdateSource(fetchImpl).check('personal-1.4.214-3b51e62d1', signal)
    ).resolves.toEqual({ kind: 'current' })
  })

  it('rejects on an installed release probe failure instead of guessing order', async () => {
    const { fetchImpl, requested } = fakeFetch({
      [releaseTagUrl('personal-1.4.214-3b51e62d1')]: { status: 502 }
    })
    await expect(
      createPersonalReleaseUpdateSource(fetchImpl).check('personal-1.4.214-3b51e62d1', signal)
    ).rejects.toThrow('installed release HTTP 502')
    expect(requested).toEqual([releaseTagUrl('personal-1.4.214-3b51e62d1')])
  })

  it('rejects on a releases list failure', async () => {
    const { fetchImpl } = fakeFetch({
      [releaseTagUrl('personal-1.4.214-3b51e62d1')]: { status: 200, body: release520 },
      [RELEASES_URL]: { status: 503 }
    })
    await expect(
      createPersonalReleaseUpdateSource(fetchImpl).check('personal-1.4.214-3b51e62d1', signal)
    ).rejects.toThrow('releases HTTP 503')
  })
})

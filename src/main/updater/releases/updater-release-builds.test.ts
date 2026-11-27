import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
// Keep the personal-listing test off ambient gh auth: no token means no gh spawn and no retry legs.
vi.mock('./updater-release-api-token', () => ({
  resolveReleaseApiToken: vi.fn().mockResolvedValue(null),
  rejectReleaseApiToken: vi.fn()
}))

describe('resolveTargetBuild', () => {
  it('pins personal tags to the fork repo download base', async () => {
    const { resolveTargetBuild } = await import('./updater-release-builds')

    expect(resolveTargetBuild('personal', 'personal-1.4.214-4e2f1a0b3')).toEqual({
      tag: 'personal-1.4.214-4e2f1a0b3',
      version: '1.4.214-4e2f1a0b3',
      feedUrl: 'https://github.com/dudupii/orca/releases/download/personal-1.4.214-4e2f1a0b3'
    })
  })

  it('keeps official channels on the main repo download base', async () => {
    const { resolveTargetBuild } = await import('./updater-release-builds')

    expect(resolveTargetBuild('stable', 'v1.4.214')).toEqual({
      tag: 'v1.4.214',
      version: '1.4.214',
      feedUrl: 'https://github.com/stablyai/orca/releases/download/v1.4.214'
    })
    expect(resolveTargetBuild('rc', 'v1.4.214-rc.1').feedUrl).toBe(
      'https://github.com/stablyai/orca/releases/download/v1.4.214-rc.1'
    )
  })

  it('rejects tags that are not valid versions', async () => {
    const { resolveTargetBuild } = await import('./updater-release-builds')

    expect(() => resolveTargetBuild('stable', 'garbage')).toThrowError(
      '"garbage" is not a valid release tag.'
    )
  })
})

describe('listReleaseBuilds', () => {
  it('lists personal releases from the fork repo ordered by created_at', async () => {
    const { net } = await import('electron')
    const netFetch = vi.mocked(net.fetch)
    netFetch.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            tag_name: 'personal-1.4.214-4e2f1a0b3',
            name: null,
            draft: false,
            // Editing this older release advanced published_at past the newer build's.
            created_at: '2026-11-01T10:00:00Z',
            published_at: '2026-11-05T10:00:00Z',
            html_url: 'https://github.com/dudupii/orca/releases/tag/personal-1.4.214-4e2f1a0b3',
            assets: [{ name: 'latest-linux.yml' }, { name: 'orca-linux.AppImage' }]
          },
          {
            tag_name: 'personal-1.4.215-5f6e7d8c9',
            name: null,
            draft: false,
            created_at: '2026-11-03T10:00:00Z',
            published_at: '2026-11-03T10:00:05Z',
            html_url: 'https://github.com/dudupii/orca/releases/tag/personal-1.4.215-5f6e7d8c9',
            assets: [{ name: 'latest-linux.yml' }, { name: 'orca-linux.AppImage' }]
          },
          {
            // Stray official tags on the fork repo never enter the personal list.
            tag_name: 'v1.4.999',
            name: null,
            draft: false,
            created_at: '2026-11-04T10:00:00Z',
            published_at: '2026-11-04T10:00:00Z',
            html_url: 'https://github.com/dudupii/orca/releases/tag/v1.4.999',
            assets: [{ name: 'latest-linux.yml' }, { name: 'orca-linux.AppImage' }]
          }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    const { listReleaseBuilds } = await import('./updater-release-builds')

    const builds = await listReleaseBuilds('personal', 'linux')

    expect(netFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/dudupii/orca/releases?per_page=100&page=1',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/vnd.github+json' })
      })
    )
    expect(builds.map((build) => build.tag)).toEqual([
      'personal-1.4.215-5f6e7d8c9',
      'personal-1.4.214-4e2f1a0b3'
    ])
    expect(builds[0]).toMatchObject({
      version: '1.4.215-5f6e7d8c9',
      channel: 'personal',
      createdAt: '2026-11-03T10:00:00Z',
      installerUrl:
        'https://github.com/dudupii/orca/releases/download/personal-1.4.215-5f6e7d8c9/orca-linux.AppImage'
    })
  })
})

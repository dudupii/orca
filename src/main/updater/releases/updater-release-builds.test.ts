import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

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

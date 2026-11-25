import { describe, expect, it } from 'vitest'
import {
  getPersonalReleaseTag,
  getReleaseNotesUrlForVersion,
  getReleaseRepoForChannel,
  getVersionChannel,
  hasDedicatedReleaseRepo,
  isChannelSupportedOnPlatform,
  isKnownReleaseChannel,
  isPersonalReleaseTag,
  isReleaseChannel,
  normalizeTagToVersion,
  parseHourlyVersionStamp,
  parsePersonalReleaseTag,
  requiresManualDevChannelInstall,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild,
  type ReleaseChannel
} from './release-channel'

describe('release channel', () => {
  it('rejects impossible dates without rejecting leap day', () => {
    expect(parseHourlyVersionStamp('1.4.160-hourly.202602300000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202802290000')?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    )
  })

  it('requires a manual install only when entering a dev channel from a signed Windows build', () => {
    const manual = (runningChannel: ReleaseChannel | null, targetChannel: ReleaseChannel) =>
      requiresManualDevChannelInstall({ platform: 'win32', runningChannel, targetChannel })

    expect(manual('stable', 'adhoc')).toBe(true)
    expect(manual(null, 'adhoc')).toBe(true)
    expect(manual('hourly', 'adhoc')).toBe(false)
    expect(manual('hourly', 'stable')).toBe(false)
    expect(manual('stable', 'rc')).toBe(false)
    // Personal builds are unsigned too: entering one from a signed build is manual, leaving is not.
    expect(manual('stable', 'personal')).toBe(true)
    expect(manual('personal', 'personal')).toBe(false)
    expect(manual('personal', 'hourly')).toBe(false)
    expect(manual('personal', 'stable')).toBe(false)
  })

  it('sorts dev builds by their cut time across different base versions', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'adhoc',
      name: null,
      createdAt: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-adhoc/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.207-adhoc.20260919025813'),
      build('1.4.206-adhoc.20260919173504')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.206-adhoc.20260919173504',
      '1.4.207-adhoc.20260919025813'
    ])
  })

  it('splits picker-selectable channels from the wider known set', () => {
    for (const channel of ['stable', 'rc', 'hourly', 'daily', 'adhoc'] as const) {
      expect(isReleaseChannel(channel)).toBe(true)
      expect(isKnownReleaseChannel(channel)).toBe(true)
    }
    // Personal stays off the picker, but the listBuilds route a personal build calls still names it.
    expect(isReleaseChannel('personal')).toBe(false)
    expect(isKnownReleaseChannel('personal')).toBe(true)
    expect(isKnownReleaseChannel('garbage')).toBe(false)
    expect(isKnownReleaseChannel(null)).toBe(false)
  })
})

describe('personal release channel', () => {
  it('recognizes exactly the 9-hex personal stamp and nothing official', () => {
    expect(getVersionChannel('1.4.214-4e2f1a0b3')).toBe('personal')
    expect(getVersionChannel('1.4.214-000000000')).toBe('personal')
    // Official prerelease shapes must never file under personal.
    expect(getVersionChannel('1.4.214')).toBe('stable')
    expect(getVersionChannel('1.4.214-rc.1')).toBe('rc')
    expect(getVersionChannel('1.4.214-rc.1.perf')).toBe('rc')
    expect(getVersionChannel('1.4.214-hourly.202607281400')).toBe('hourly')
    expect(getVersionChannel('1.4.214-adhoc.20260728140102')).toBe('adhoc')
    // Near misses: wrong length and uppercase hex stay official namespaces.
    expect(getVersionChannel('1.4.214-4e2f1a0b')).toBe('rc')
    expect(getVersionChannel('1.4.214-4e2f1a0b34')).toBe('rc')
    expect(getVersionChannel('1.4.214-4E2F1A0B3')).toBe('rc')
    expect(getVersionChannel('garbage')).toBeNull()
  })

  it('resolves the personal channel to the fork repo and platform support everywhere', () => {
    expect(getReleaseRepoForChannel('personal')).toBe('dudupii/orca')
    expect(getReleaseRepoForChannel('stable')).toBe('stablyai/orca')
    expect(hasDedicatedReleaseRepo('personal')).toBe(true)
    expect(hasDedicatedReleaseRepo('stable')).toBe(false)
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(isChannelSupportedOnPlatform('personal', platform)).toBe(true)
    }
  })

  it('round-trips personal tags through version and tag helpers', () => {
    expect(normalizeTagToVersion('personal-1.4.214-4e2f1a0b3')).toBe('1.4.214-4e2f1a0b3')
    expect(normalizeTagToVersion('v1.4.214')).toBe('1.4.214')
    expect(getPersonalReleaseTag('1.4.214-4e2f1a0b3')).toBe('personal-1.4.214-4e2f1a0b3')
    expect(parsePersonalReleaseTag('personal-1.4.214-4e2f1a0b3')).toBe('1.4.214-4e2f1a0b3')
    expect(isPersonalReleaseTag('personal-1.4.214-4e2f1a0b3')).toBe(true)
    // Stray tags on the fork repo never count as personal releases.
    expect(parsePersonalReleaseTag('v1.4.214')).toBeNull()
    expect(parsePersonalReleaseTag('personal-1.4.214')).toBeNull()
    expect(parsePersonalReleaseTag('personal-garbage')).toBeNull()
    expect(isPersonalReleaseTag('v1.4.214-4e2f1a0b3')).toBe(false)
  })

  it('links personal versions to the fork tag and official versions to the main repo', () => {
    expect(getReleaseNotesUrlForVersion('1.4.214-4e2f1a0b3')).toBe(
      'https://github.com/dudupii/orca/releases/tag/personal-1.4.214-4e2f1a0b3'
    )
    expect(getReleaseNotesUrlForVersion('1.4.214')).toBe(
      'https://github.com/stablyai/orca/releases/tag/v1.4.214'
    )
    expect(getReleaseNotesUrlForVersion('1.4.214-rc.1')).toBe(
      'https://github.com/stablyai/orca/releases/tag/v1.4.214-rc.1'
    )
  })

  it('sorts personal builds by created_at across one base version', () => {
    const build = (version: string, createdAt: string): ReleaseBuild => ({
      tag: `personal-${version}`,
      version,
      channel: 'personal',
      name: null,
      createdAt,
      publishedAt: null,
      releaseUrl: `https://github.com/dudupii/orca/releases/tag/personal-${version}`,
      installerUrl: null
    })
    // Semver sorts the later-rebuilt 111112222 last (1 < f); build order must follow created_at.
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.214-fffff9999', '2026-11-01T10:00:00Z'),
      build('1.4.214-111112222', '2026-11-03T10:00:00Z'),
      build('1.4.215-bbbbb2222', '2026-11-02T10:00:00Z')
    ])
    expect(sorted.map((entry) => entry.tag)).toEqual([
      'personal-1.4.214-111112222',
      'personal-1.4.215-bbbbb2222',
      'personal-1.4.214-fffff9999'
    ])
  })

  it('keeps an edited older personal release below newer builds despite its advanced published_at', () => {
    const build = (version: string, createdAt: string, publishedAt: string): ReleaseBuild => ({
      tag: `personal-${version}`,
      version,
      channel: 'personal',
      name: null,
      createdAt,
      publishedAt,
      releaseUrl: `https://github.com/dudupii/orca/releases/tag/personal-${version}`,
      installerUrl: null
    })
    // Editing the older release advanced its published_at past the newest build's; created_at must still order it last.
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.214-4e2f1a0b3', '2026-11-01T10:00:00Z', '2026-11-05T10:00:00Z'),
      build('1.4.215-5f6e7d8c9', '2026-11-03T10:00:00Z', '2026-11-03T10:00:05Z')
    ])
    expect(sorted.map((entry) => entry.tag)).toEqual([
      'personal-1.4.215-5f6e7d8c9',
      'personal-1.4.214-4e2f1a0b3'
    ])
  })
})

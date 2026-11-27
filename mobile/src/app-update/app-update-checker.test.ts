import { describe, expect, it } from 'vitest'
import { createAppUpdateChecker } from './app-update-checker'
import { isNewerReleaseVersion } from './app-update-source'
import { isStoredPersonalUpdateNewer } from './personal-update-channel'
import type { KnownAppUpdate } from '../storage/app-update-preferences'

// The stored-latest gate is channel-shaped: official channels compare semver while personal tags
// only clear by identity, so the same stored update must behave differently under each predicate.
const PERSONAL_TAG = 'personal-1.4.214-520cdf128'
const PERSONAL_UPDATE: KnownAppUpdate = {
  version: PERSONAL_TAG,
  url: 'https://github.com/dudupii/orca/releases/tag/personal-1.4.214-520cdf128'
}

function checkerWith(args: {
  isStoredLatestNewer: (latestVersion: string, installedVersion: string) => boolean
  installedVersion: string | null
  latest: KnownAppUpdate | null
}) {
  return createAppUpdateChecker({
    source: { check: async () => ({ kind: 'current' }) },
    isStoredLatestNewer: args.isStoredLatestNewer,
    installedVersion: args.installedVersion,
    now: () => 0,
    setTimer: () => setTimeout(() => {}, 0),
    clearTimer: () => {},
    subscribeForeground: () => () => {},
    loadPreferences: async () => ({
      lastCheckedAt: 1000,
      latest: args.latest,
      dismissedVersion: null
    }),
    saveCheck: async () => {},
    saveDismissedVersion: async () => {}
  })
}

async function flushLoading(): Promise<void> {
  // The preference load and its publish run as microtasks; one timer turn drains them all.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('stored app update gate', () => {
  it('surfaces a stored personal tag until the installed tag matches it', async () => {
    const olderInstall = checkerWith({
      isStoredLatestNewer: isStoredPersonalUpdateNewer,
      installedVersion: 'personal-1.4.214-3b51e62d1',
      latest: PERSONAL_UPDATE
    })
    const stopOlder = olderInstall.start()
    await flushLoading()
    expect(olderInstall.getSnapshot().available).toEqual(PERSONAL_UPDATE)
    stopOlder()

    const sameInstall = checkerWith({
      isStoredLatestNewer: isStoredPersonalUpdateNewer,
      installedVersion: PERSONAL_TAG,
      latest: PERSONAL_UPDATE
    })
    const stopSame = sameInstall.start()
    await flushLoading()
    expect(sameInstall.getSnapshot().available).toEqual(null)
    stopSame()
  })

  it('offers nothing at cold start when a personal install inherited an official stored latest', async () => {
    // Preferences are not channel-qualified, so a personal APK installed over an official one
    // (same package) reads the official channel's latest on first launch; it has no personal
    // build order, so the home card must stay empty until the personal check runs.
    const inheritedOfficial = checkerWith({
      isStoredLatestNewer: isStoredPersonalUpdateNewer,
      installedVersion: PERSONAL_TAG,
      latest: {
        version: '0.0.70',
        url: 'https://github.com/stablyai/orca/releases/tag/android-v0.0.70'
      }
    })
    const stop = inheritedOfficial.start()
    await flushLoading()
    expect(inheritedOfficial.getSnapshot().available).toEqual(null)
    stop()
  })

  it('keeps the official semver gate, where a stored personal tag never qualifies', async () => {
    const officialSemver = checkerWith({
      isStoredLatestNewer: isNewerReleaseVersion,
      installedVersion: '0.0.51',
      latest: {
        version: '0.0.52',
        url: 'https://github.com/stablyai/orca/releases/tag/mobile-android-v0.0.52'
      }
    })
    const stopSemver = officialSemver.start()
    await flushLoading()
    expect(officialSemver.getSnapshot().available).toEqual({
      version: '0.0.52',
      url: 'https://github.com/stablyai/orca/releases/tag/mobile-android-v0.0.52'
    })
    stopSemver()

    const storedPersonalTag = checkerWith({
      isStoredLatestNewer: isNewerReleaseVersion,
      installedVersion: '0.0.51',
      latest: PERSONAL_UPDATE
    })
    const stopTag = storedPersonalTag.start()
    await flushLoading()
    expect(storedPersonalTag.getSnapshot().available).toEqual(null)
    stopTag()
  })
})

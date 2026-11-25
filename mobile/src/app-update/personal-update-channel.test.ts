import { describe, expect, it } from 'vitest'
import {
  isNewerPersonalRelease,
  isStoredPersonalUpdateNewer,
  resolveAppUpdateChannel
} from './personal-update-channel'

// Tags and timestamps taken from the fork's live releases page on 2026-11-25.
describe('personal update channel detection', () => {
  it('classifies the fork workflow variant as personal and names its tag', () => {
    expect(resolveAppUpdateChannel('dudupii/personal-1.4.214-520cdf128')).toEqual({
      kind: 'personal',
      installedTag: 'personal-1.4.214-520cdf128'
    })
  })

  it('keeps official builds official: no variant, foreign prefix, or bare prefix', () => {
    expect(resolveAppUpdateChannel(undefined)).toEqual({ kind: 'official' })
    expect(resolveAppUpdateChannel('')).toEqual({ kind: 'official' })
    expect(resolveAppUpdateChannel('stablyai/orca')).toEqual({ kind: 'official' })
    expect(resolveAppUpdateChannel('dudupii/')).toEqual({ kind: 'official' })
  })
})

describe('personal release build order', () => {
  const installed = { tag: 'personal-1.4.214-3b51e62d1', createdAt: '2026-11-23T05:35:22Z' }

  it('offers a release built after the installed one', () => {
    expect(
      isNewerPersonalRelease(
        { tag: 'personal-1.4.214-520cdf128', createdAt: '2026-11-24T22:33:08Z' },
        installed
      )
    ).toBe(true)
  })

  it('never offers the installed tag back, whatever its timestamp', () => {
    expect(
      isNewerPersonalRelease({ ...installed, createdAt: '2027-01-01T00:00:00Z' }, installed)
    ).toBe(false)
  })

  it('rejects a release built before the installed one', () => {
    expect(
      isNewerPersonalRelease(
        { tag: 'personal-1.4.197-dc3184fbd', createdAt: '2026-09-20T21:18:35Z' },
        installed
      )
    ).toBe(false)
  })

  it('rejects same-second builds and unparseable or missing baselines', () => {
    const equal = { tag: 'personal-1.4.214-aaaaaaaaa', createdAt: installed.createdAt }
    expect(isNewerPersonalRelease(equal, installed)).toBe(false)
    expect(
      isNewerPersonalRelease(
        { tag: 'personal-1.4.214-aaaaaaaaa', createdAt: 'not-a-date' },
        installed
      )
    ).toBe(false)
    expect(
      isNewerPersonalRelease(
        { tag: 'personal-1.4.214-520cdf128', createdAt: '2026-11-24T22:33:08Z' },
        { ...installed, createdAt: 'garbage' }
      )
    ).toBe(false)
    expect(
      isNewerPersonalRelease(
        { tag: 'personal-1.4.214-520cdf128', createdAt: '2026-11-24T22:33:08Z' },
        null
      )
    ).toBe(false)
  })
})

describe('stored personal update against the installed tag', () => {
  it('clears once the stored tag is installed and stays offered otherwise', () => {
    expect(
      isStoredPersonalUpdateNewer('personal-1.4.214-520cdf128', 'personal-1.4.214-520cdf128')
    ).toBe(false)
    expect(
      isStoredPersonalUpdateNewer('personal-1.4.214-520cdf128', 'personal-1.4.214-3b51e62d1')
    ).toBe(true)
  })
})

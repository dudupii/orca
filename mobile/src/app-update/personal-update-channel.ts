/**
 * The fork's release workflow bakes its personal tag into every build it ships as
 * `EXPO_PUBLIC_ORCA_BUILD_VARIANT: dudupii/<tag>` (Metro inlines EXPO_PUBLIC_* into the release
 * JS). Official builds set no variant, so everything about this module is inert for them.
 */

/** Variant values carrying this prefix were built by the fork's personal release workflow. */
export const PERSONAL_VARIANT_PREFIX = 'dudupii/'

export type AppUpdateChannel =
  | { readonly kind: 'official' }
  | { readonly kind: 'personal'; readonly installedTag: string }

/** Classifies a baked build variant: a personal build names the exact release tag it was built from. */
export function resolveAppUpdateChannel(variant: string | undefined): AppUpdateChannel {
  if (variant === undefined || !variant.startsWith(PERSONAL_VARIANT_PREFIX)) {
    return { kind: 'official' }
  }
  const installedTag = variant.slice(PERSONAL_VARIANT_PREFIX.length)
  // A bare `dudupii/` names no release; treat it as official rather than probe a garbage tag.
  return installedTag ? { kind: 'personal', installedTag } : { kind: 'official' }
}

export type PersonalReleaseIdentity = {
  /** The release's tag, e.g. `personal-1.4.214-520cdf128`. */
  readonly tag: string
  /** The release's `created_at`: personal tags don't increment, so this carries the build order. */
  readonly createdAt: string
}

/**
 * Personal tags share the base version and differ only by a commit short hash, so semver cannot
 * order them; build order is the release creation time. The same tag never qualifies, nor does an
 * unknown (`null`) baseline or an unparseable timestamp.
 */
export function isNewerPersonalRelease(
  candidate: PersonalReleaseIdentity,
  installed: PersonalReleaseIdentity | null
): boolean {
  if (installed === null || candidate.tag === installed.tag) {
    return false
  }
  const candidateAt = Date.parse(candidate.createdAt)
  const installedAt = Date.parse(installed.createdAt)
  return Number.isFinite(candidateAt) && Number.isFinite(installedAt) && candidateAt > installedAt
}

/**
 * Offline re-check that a stored update still beats the installed build: order is unknowable
 * without the network, so only the same tag is known stale. Installing the update clears the
 * banner, and a manual sideload past the stored tag self-heals at the next check.
 */
export function isStoredPersonalUpdateNewer(latestTag: string, installedTag: string): boolean {
  return latestTag !== installedTag
}

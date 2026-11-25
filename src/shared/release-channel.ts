import { compareAppVersions, isValidAppVersion } from './app-version'

export type ReleaseChannel = 'stable' | 'rc' | 'hourly' | 'daily' | 'adhoc' | 'personal'

/**
 * Picker-listed channels. The personal channel stays off this list: it exists only inside the
 * fork that publishes it, so official builds must never offer it as a browsing option.
 */
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = [
  'stable',
  'rc',
  'hourly',
  'daily',
  'adhoc'
]

export const RELEASE_CHANNEL_LABELS: Readonly<Record<ReleaseChannel, string>> = {
  stable: 'Stable',
  rc: 'RC',
  hourly: 'Hourly',
  daily: 'Daily',
  adhoc: 'Adhoc',
  personal: 'Personal'
}

/** Keep dev tags out of the 10-entry main releases feed, where hourlies would evict stable/RC updates. */
export const HOURLY_RELEASE_REPO = 'stablyai/orca-hourly'
export const DAILY_RELEASE_REPO = 'stablyai/orca-daily'
export const ADHOC_RELEASE_REPO = 'stablyai/orca-adhoc'
export const MAIN_RELEASE_REPO = 'stablyai/orca'

/** Personal-channel releases live on the fork that builds them, not on the main repo. */
export const PERSONAL_RELEASE_REPO = 'dudupii/orca'

/** Personal release tags are `personal-<version>`, e.g. `personal-1.4.214-4e2f1a0b3`. */
export const PERSONAL_RELEASE_TAG_PREFIX = 'personal-'

/** The dev channels, each published to its own repo rather than the main one. */
const DEDICATED_REPO_CHANNELS = ['hourly', 'daily', 'adhoc', 'personal'] as const

export type DedicatedRepoChannel = (typeof DEDICATED_REPO_CHANNELS)[number]

const CHANNEL_RELEASE_REPOS: Record<ReleaseChannel, string> = {
  stable: MAIN_RELEASE_REPO,
  rc: MAIN_RELEASE_REPO,
  hourly: HOURLY_RELEASE_REPO,
  daily: DAILY_RELEASE_REPO,
  adhoc: ADHOC_RELEASE_REPO,
  personal: PERSONAL_RELEASE_REPO
}

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return typeof value === 'string' && RELEASE_CHANNELS.includes(value as ReleaseChannel)
}

/** True for channels published outside the main repo. The updater reports these
 *  as a distinct source so a pinned dev build is never mistaken for a release. */
export function hasDedicatedReleaseRepo(channel: ReleaseChannel): channel is DedicatedRepoChannel {
  return (DEDICATED_REPO_CHANNELS as readonly ReleaseChannel[]).includes(channel)
}

/** Repository separation does not imply platform availability; dev workflows publish macOS/Windows, while Linux retains stable/RC.
 *  Personal releases build every desktop platform, so their channel stays selectable everywhere. */
const DEV_CHANNEL_PLATFORMS: Readonly<Record<DedicatedRepoChannel, readonly NodeJS.Platform[]>> = {
  hourly: ['darwin', 'win32'],
  daily: ['darwin', 'win32'],
  adhoc: ['darwin', 'win32'],
  personal: ['darwin', 'win32', 'linux']
}

/** Shared availability copy must stay aligned with the platform table. */
export const DEV_CHANNEL_PLATFORM_LABEL = 'macOS and Windows'

/** Share platform gating across picker and update checks. */
export function isChannelSupportedOnPlatform(
  channel: ReleaseChannel,
  platform: NodeJS.Platform
): boolean {
  if (!hasDedicatedReleaseRepo(channel)) {
    return true
  }
  return DEV_CHANNEL_PLATFORMS[channel].includes(platform)
}

/** Windows signed apps reject unsigned dev installers using installed publisherName; future builds cannot fix that baked-in policy.
 * Dev apps omit the name and can switch out freely; only entry from signed builds needs manual install. Unknown running versions
 * conservatively assume signed. Signing approval takes hours and cannot fit dev cadence. */
export function requiresManualDevChannelInstall(options: {
  platform: NodeJS.Platform
  runningChannel: ReleaseChannel | null
  targetChannel: ReleaseChannel
}): boolean {
  const { platform, runningChannel, targetChannel } = options
  if (platform !== 'win32' || !hasDedicatedReleaseRepo(targetChannel)) {
    return false
  }
  return runningChannel === null || !hasDedicatedReleaseRepo(runningChannel)
}

export function getReleaseRepoForChannel(channel: ReleaseChannel): string {
  return CHANNEL_RELEASE_REPOS[channel]
}

export function normalizeTagToVersion(tag: string): string {
  // Release tags are `v<version>`; personal-channel releases instead prefix `personal-`.
  return tag.replace(/^v/i, '').replace(/^personal-/, '')
}

/** Personal builds stamp the first 9 hex characters of the build commit as the whole prerelease
 *  (1.4.214-4e2f1a0b3). No official channel ever produces a bare 9-hex-digit prerelease, so the
 *  shape alone identifies the fork's builds — official versions can never parse as personal. */
const PERSONAL_VERSION = /^\d+\.\d+\.\d+-[0-9a-f]{9}$/

export function isPersonalVersion(version: string): boolean {
  return PERSONAL_VERSION.test(normalizeTagToVersion(version))
}

export function getPersonalReleaseTag(version: string): string {
  return `${PERSONAL_RELEASE_TAG_PREFIX}${normalizeTagToVersion(version)}`
}

/** Version carried by a `personal-<version>` release tag; null for every other tag shape. */
export function parsePersonalReleaseTag(tag: string): string | null {
  if (!tag.startsWith(PERSONAL_RELEASE_TAG_PREFIX)) {
    return null
  }
  const version = tag.slice(PERSONAL_RELEASE_TAG_PREFIX.length)
  return isPersonalVersion(version) ? version : null
}

export function isPersonalReleaseTag(tag: string): boolean {
  return parsePersonalReleaseTag(tag) !== null
}

/** Timestamp versions prevent electron-updater treating successive builds as identical (1.4.160-hourly.202607281400). */
const HOURLY_VERSION = /^\d+\.\d+\.\d+-hourly\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/

/** Minute-stamped daily versions also permit unique forced recuts later the same day. */
const DAILY_VERSION = /^\d+\.\d+\.\d+-daily\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/

/** Use second-resolution adhoc stamps: concurrent branch dispatches lack hourly/daily serialization and can collide within a minute. */
const ADHOC_VERSION = /^\d+\.\d+\.\d+-adhoc\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/

/** Anchor the whole version so garbage prefixes cannot parse as valid build stamps. */
function parseStampedVersion(version: string, pattern: RegExp): Date | null {
  const match = normalizeTagToVersion(version).match(pattern)
  if (!match) {
    return null
  }
  const [year, month, day, hour, minute, second = 0] = match.slice(1).map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  // Round-trip components because Date.UTC normalizes impossible dates (February 30→March 2).
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    return null
  }
  return parsed
}

export function isHourlyVersion(version: string): boolean {
  return HOURLY_VERSION.test(normalizeTagToVersion(version))
}

export function isDailyVersion(version: string): boolean {
  return DAILY_VERSION.test(normalizeTagToVersion(version))
}

export function isAdhocVersion(version: string): boolean {
  return ADHOC_VERSION.test(normalizeTagToVersion(version))
}

export function parseHourlyVersionStamp(version: string): Date | null {
  return parseStampedVersion(version, HOURLY_VERSION)
}

export function parseDailyVersionStamp(version: string): Date | null {
  return parseStampedVersion(version, DAILY_VERSION)
}

export function parseAdhocVersionStamp(version: string): Date | null {
  return parseStampedVersion(version, ADHOC_VERSION)
}

/** Read any dev build timestamp so picker rows need no per-channel branching. */
export function parseDevBuildStamp(version: string): Date | null {
  return (
    parseHourlyVersionStamp(version) ??
    parseDailyVersionStamp(version) ??
    parseAdhocVersionStamp(version)
  )
}

export function getVersionChannel(version: string): ReleaseChannel | null {
  const normalized = normalizeTagToVersion(version)
  if (!isValidAppVersion(normalized)) {
    return null
  }
  if (isHourlyVersion(normalized)) {
    return 'hourly'
  }
  if (isDailyVersion(normalized)) {
    return 'daily'
  }
  if (isAdhocVersion(normalized)) {
    return 'adhoc'
  }
  // Why the dev channels are tested first: they are prereleases too, so this
  // catch-all would otherwise file every one of them under rc.
  if (isPersonalVersion(normalized)) {
    return 'personal'
  }
  return normalized.includes('-') ? 'rc' : 'stable'
}

/** Dev tags need their publishing repo or links 404. Missing versions use the releases list; latest can fail during GitHub API degradation. */
export function getReleaseNotesUrlForVersion(version: string | null): string {
  const channel = version ? getVersionChannel(version) : null
  const repo = channel ? getReleaseRepoForChannel(channel) : MAIN_RELEASE_REPO
  // Personal tags carry the `personal-` prefix instead of `v`; every other channel tags `v<version>`.
  if (channel === 'personal' && version) {
    return `https://github.com/${repo}/releases/tag/${getPersonalReleaseTag(version)}`
  }
  return version
    ? `https://github.com/${repo}/releases/tag/v${normalizeTagToVersion(version)}`
    : `https://github.com/${repo}/releases`
}

/** Require each platform’s updater manifest: missing/in-progress platform legs must not offer picker entries whose downloads 404. */
const PLATFORM_UPDATE_MANIFESTS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['latest-mac.yml'],
  win32: ['latest.yml'],
  // Both, because one release carries x64 and arm64 and either makes it installable.
  linux: ['latest-linux.yml', 'latest-linux-arm64.yml']
}

export function getUpdateManifestNamesForPlatform(platform: NodeJS.Platform): readonly string[] {
  return PLATFORM_UPDATE_MANIFESTS[platform] ?? []
}

/** True when the release carries an artifact this platform's updater can install. */
export function hasInstallableArtifactForPlatform(
  platform: NodeJS.Platform,
  assetNames: readonly string[]
): boolean {
  const manifests = getUpdateManifestNamesForPlatform(platform)
  // Unknown platforms should fail with a download explanation rather than an empty picker.
  if (manifests.length === 0) {
    return true
  }
  return manifests.some((manifest) => assetNames.includes(manifest))
}

/** Match electron-builder’s runnable installer names for manual bootstrap when in-app switching cannot work. */
const PLATFORM_INSTALLER_PATTERNS: Partial<Record<NodeJS.Platform, RegExp>> = {
  darwin: /\.dmg$/i,
  win32: /windows-setup\.exe$/i,
  linux: /\.AppImage$/i
}

export function findInstallerAssetName(
  platform: NodeJS.Platform,
  assetNames: readonly string[]
): string | null {
  const pattern = PLATFORM_INSTALLER_PATTERNS[platform]
  if (!pattern) {
    return null
  }
  return assetNames.find((name) => pattern.test(name)) ?? null
}

export type ReleaseBuild = {
  tag: string
  version: string
  channel: ReleaseChannel
  /** Null for missing/tag-repeated titles so the picker distinguishes workflow names from unnamed builds. */
  name: string | null
  publishedAt: string | null
  releaseUrl: string
  /** Platform installer, null when unpublished; signed Windows builds use this to bootstrap unsigned dev channels. */
  installerUrl: string | null
}

/** Newest first, so the picker's first row is always the channel's current tip. */
export function sortReleaseBuildsNewestFirst(builds: ReleaseBuild[]): ReleaseBuild[] {
  return [...builds].sort((left, right) => {
    // Branches can predate current main’s base version; use dev build time rather than semver for picker recency.
    const leftStamp = parseDevBuildStamp(left.version)?.getTime() ?? null
    const rightStamp = parseDevBuildStamp(right.version)?.getTime() ?? null
    if (leftStamp !== null && rightStamp !== null && leftStamp !== rightStamp) {
      return rightStamp - leftStamp
    }

    if (hasDedicatedReleaseRepo(left.channel) && hasDedicatedReleaseRepo(right.channel)) {
      const leftPublished = left.publishedAt ? Date.parse(left.publishedAt) : Number.NaN
      const rightPublished = right.publishedAt ? Date.parse(right.publishedAt) : Number.NaN
      if (
        Number.isFinite(leftPublished) &&
        Number.isFinite(rightPublished) &&
        leftPublished !== rightPublished
      ) {
        return rightPublished - leftPublished
      }
    }

    return compareAppVersions(right.version, left.version)
  })
}

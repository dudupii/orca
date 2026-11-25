import { net } from 'electron'
import { compareVersions, isPrereleaseVersion, isValidVersion } from './updater-fallback'
import {
  FETCH_TIMEOUT_MS,
  getPlatformManifestReadiness,
  requestGitHubReleaseHead
} from './updater-release-readiness'
import {
  getPersonalReleaseTag,
  isPersonalReleaseTag,
  isPersonalVersion,
  PERSONAL_RELEASE_REPO
} from '../../../shared/release-channel'

import {
  applyReleaseDelay,
  type DatedReleaseTag,
  type ReleaseDelayResult
} from './updater-release-delay'

const ATOM_FEED_URL = 'https://github.com/stablyai/orca/releases.atom'
const PERSONAL_ATOM_FEED_URL = `https://github.com/${PERSONAL_RELEASE_REPO}/releases.atom`
const MAX_MANIFEST_PROBE_CANDIDATES = 6

// Atom includes stable and prerelease tags without channel filtering.
const ENTRY_RE = /<entry>([\s\S]*?)<\/entry>/g
const TAG_HREF_RE = /href="https:\/\/github\.com\/stablyai\/orca\/releases\/tag\/([^"]+)"/
const PERSONAL_TAG_HREF_RE = new RegExp(
  `href="https://github\\.com/${PERSONAL_RELEASE_REPO.replaceAll('/', '\\/')}/releases/tag/([^"]+)"`
)
const ENTRY_UPDATED_RE = /<updated>([^<]+)<\/updated>/

export function normalizeTagToVersion(tag: string): string {
  // Release tags are `v<version>`; personal-channel releases instead prefix `personal-`.
  return tag.replace(/^v/i, '').replace(/^personal-/, '')
}

type ReleaseFeedTag = DatedReleaseTag

export function isPerfPrereleaseTag(tag: string): boolean {
  const version = normalizeTagToVersion(tag)
  const match = version.match(/^\d+\.\d+\.\d+-([0-9A-Za-z-.]+)(?:\+[0-9A-Za-z-.]+)?$/)
  const identifiers = match?.[1]?.split('.') ?? []
  return (
    identifiers.length === 3 &&
    identifiers[0] === 'rc' &&
    /^\d+$/.test(identifiers[1]) &&
    identifiers[2] === 'perf'
  )
}

/** Personal builds order by release recency; semver cannot order commit-hash suffixes of one base version. */
function comparePersonalFeedTags(left: DatedReleaseTag, right: DatedReleaseTag): number {
  // Unknown dates sort last so known-newer releases win the newest-first slot.
  const leftAt = left.releasedAt ?? Number.NEGATIVE_INFINITY
  const rightAt = right.releasedAt ?? Number.NEGATIVE_INFINITY
  if (leftAt !== rightAt) {
    return rightAt - leftAt
  }
  return compareVersions(right.version, left.version)
}

async function fetchReleaseFeedTags(currentVersion: string): Promise<ReleaseFeedTag[] | null> {
  // The running version picks the feed: personal builds track only the fork's releases.
  const personal = isPersonalVersion(currentVersion)
  const atomUrl = personal ? PERSONAL_ATOM_FEED_URL : ATOM_FEED_URL
  const tagHrefRe = personal ? PERSONAL_TAG_HREF_RE : TAG_HREF_RE
  try {
    const res = await net.fetch(atomUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      return null
    }
    const body = await res.text()
    const tags: ReleaseFeedTag[] = []

    for (const entry of body.matchAll(ENTRY_RE)) {
      const tag = entry[1].match(tagHrefRe)?.[1]
      if (!tag) {
        continue
      }
      // The fork repo can carry stray non-personal tags; the personal channel trusts only its own.
      if (personal && !isPersonalReleaseTag(tag)) {
        continue
      }
      const version = normalizeTagToVersion(tag)
      if (isValidVersion(version) && (!personal || isPersonalVersion(version))) {
        const releasedAt = Date.parse(entry[1].match(ENTRY_UPDATED_RE)?.[1] ?? '')
        tags.push({ tag, version, releasedAt: Number.isNaN(releasedAt) ? null : releasedAt })
      }
    }

    tags.sort((left, right) =>
      personal ? comparePersonalFeedTags(left, right) : compareVersions(right.version, left.version)
    )
    return tags
  } catch {
    return null
  }
}

export async function fetchLatestStableReleaseTag(): Promise<string | null> {
  try {
    // Resolve only the release-page redirect; installer redirects continue on to signed storage URLs.
    const latestUrl = 'https://github.com/stablyai/orca/releases/latest'
    const response = await requestGitHubReleaseHead(latestUrl)
    if (!response?.redirectUrl || response.statusCode < 300 || response.statusCode >= 400) {
      return null
    }
    const target = new URL(response.redirectUrl, latestUrl)
    const match = target.pathname.match(/^\/stablyai\/orca\/releases\/tag\/([^/]+)$/)
    if (target.origin !== 'https://github.com' || !match) {
      return null
    }
    const tag = decodeURIComponent(match[1])
    const version = normalizeTagToVersion(tag)
    if (!isValidVersion(version) || isPrereleaseVersion(version)) {
      return null
    }
    return (await getPlatformManifestReadiness(tag)) === 'ready' ? tag : null
  } catch {
    return null
  }
}

// Concrete tags keep manifests and downloaded assets on the same release.
type FetchNewerReleaseTagOptions = {
  includePrerelease?: boolean
  releaseFilter?: 'perf'
  /** User update delay: only releases public at least this long are offered. */
  minReleaseAgeMs?: number
  now?: number
}

type FetchNewerReleaseTagsBaseResult =
  | { tags: string[]; state: 'ready' }
  | { tags: string[]; state: 'no-newer' }
  | { tags: string[]; state: 'not-ready'; lastGoodTag?: string }
  | { tags: string[]; state: 'unavailable'; unavailableReason: 'feed' | 'manifest' }

export type FetchNewerReleaseTagsResult = FetchNewerReleaseTagsBaseResult & {
  releaseDelay?: ReleaseDelayResult
}

export async function fetchNewerReleaseTag(
  currentVersion: string,
  options: FetchNewerReleaseTagOptions = {}
): Promise<string | null> {
  return (await fetchNewerReleaseTags(currentVersion, 1, options))[0] ?? null
}

export async function fetchNewerReleaseTags(
  currentVersion: string,
  maxTags: number,
  options: FetchNewerReleaseTagOptions = {}
): Promise<string[]> {
  return (await fetchNewerReleaseTagsWithReadiness(currentVersion, maxTags, options)).tags
}

/** Decide whether a feed entry is newer than the running build.
 *  Official channels order by semver. Personal builds order by release recency: the installed
 *  release's own feed entry anchors the comparison, the same tag is never newer, and a release
 *  absent from the 10-entry feed is older than everything listed. */
function createNewerReleaseTagTest(
  currentVersion: string,
  allTags: DatedReleaseTag[]
): (entry: DatedReleaseTag) => boolean {
  if (!isPersonalVersion(currentVersion)) {
    return ({ version }) => compareVersions(version, currentVersion) > 0
  }
  const installedTag = getPersonalReleaseTag(currentVersion)
  const installed = allTags.find(({ tag }) => tag === installedTag) ?? null
  return ({ tag, releasedAt }) => {
    if (tag === installedTag || releasedAt === null) {
      return false
    }
    if (installed === null || installed.releasedAt === null) {
      // Unknown installed recency fails closed: only feed presence, never guesswork, promotes a release.
      return installed === null
    }
    return releasedAt > installed.releasedAt
  }
}

export async function fetchNewerReleaseTagsWithReadiness(
  currentVersion: string,
  maxTags: number,
  options: FetchNewerReleaseTagOptions = {}
): Promise<FetchNewerReleaseTagsResult> {
  const includePrerelease = options.includePrerelease ?? true
  if (maxTags <= 0) {
    return { tags: [], state: 'no-newer' }
  }
  const tags = await fetchReleaseFeedTags(currentVersion)
  if (!tags) {
    return { tags: [], state: 'unavailable', unavailableReason: 'feed' }
  }
  const isNewerReleaseTag = createNewerReleaseTagTest(currentVersion, tags)
  const personal = isPersonalVersion(currentVersion)

  // Perf builds require explicit opt-in, even when semver considers them newer.
  // The personal feed already carries only personal-* tags, so channel filters do not apply.
  const channelCandidates = personal
    ? tags
    : options.releaseFilter === 'perf'
      ? tags.filter(({ tag }) => isPerfPrereleaseTag(tag))
      : includePrerelease
        ? tags.filter(({ tag }) => !isPerfPrereleaseTag(tag))
        : tags.filter(({ version }) => !isPrereleaseVersion(version))
  if (!options.minReleaseAgeMs || options.minReleaseAgeMs <= 0) {
    return resolveNewerReleaseTags(channelCandidates, isNewerReleaseTag, maxTags)
  }
  const { eligible, releaseDelay } = applyReleaseDelay(
    channelCandidates,
    tags,
    options.minReleaseAgeMs,
    options.now ?? Date.now(),
    isNewerReleaseTag
  )
  return {
    ...(await resolveNewerReleaseTags(eligible, isNewerReleaseTag, maxTags)),
    releaseDelay
  }
}

async function resolveNewerReleaseTags(
  candidates: ReleaseFeedTag[],
  isNewerReleaseTag: (entry: DatedReleaseTag) => boolean,
  maxTags: number
): Promise<FetchNewerReleaseTagsBaseResult> {
  const newestNewerIndex = candidates.findIndex((entry) => isNewerReleaseTag(entry))
  if (newestNewerIndex === -1) {
    return { tags: [], state: 'no-newer' }
  }

  // Bound probes when cancelled releases leave multiple entries without manifests.
  const probeCandidates = candidates.slice(
    newestNewerIndex,
    newestNewerIndex + MAX_MANIFEST_PROBE_CANDIDATES
  )
  const manifestResults = await Promise.all(
    probeCandidates.map(async (entry) => ({
      entry,
      readiness: await getPlatformManifestReadiness(entry.tag)
    }))
  )

  const primaryIndex = manifestResults.findIndex(
    ({ readiness, entry }) => readiness === 'ready' && isNewerReleaseTag(entry)
  )
  if (primaryIndex === -1) {
    if (manifestResults[0]?.readiness === 'unavailable') {
      return { tags: [], state: 'unavailable', unavailableReason: 'manifest' }
    }
    const lastGoodTag = manifestResults.find(({ readiness }) => readiness === 'ready')?.entry.tag
    return lastGoodTag
      ? { tags: [], state: 'not-ready', lastGoodTag }
      : { tags: [], state: 'not-ready' }
  }

  if (primaryIndex > 0) {
    if (manifestResults[0]?.readiness === 'unavailable') {
      return { tags: [], state: 'unavailable', unavailableReason: 'manifest' }
    }
    return {
      tags: [],
      state: 'not-ready',
      lastGoodTag: manifestResults[primaryIndex].entry.tag
    }
  }

  return {
    tags: manifestResults
      .slice(primaryIndex)
      .filter(({ readiness }) => readiness === 'ready')
      .slice(0, maxTags)
      .map(({ entry }) => entry.tag),
    state: 'ready'
  }
}

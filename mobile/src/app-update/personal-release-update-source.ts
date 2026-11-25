import { z } from 'zod'
import type { AppUpdateCheckResult, AppUpdateSource } from './app-update-source'
import {
  isNewerPersonalRelease,
  PERSONAL_RELEASE_TAG_PREFIX,
  type PersonalReleaseIdentity
} from './personal-update-channel'

// The fork's own repo: every personal-* tag's release carries the APK alongside the desktop packages.
const RELEASES_API = 'https://api.github.com/repos/dudupii/orca/releases'

type Fetch = typeof fetch

export type PersonalRelease = PersonalReleaseIdentity & { readonly pageUrl: string }

const releaseListSchema = z.array(z.unknown())
const installableReleaseSchema = z.looseObject({
  tag_name: z.string(),
  created_at: z.string(),
  draft: z.literal(false),
  html_url: z.string(),
  assets: z.array(z.looseObject({ name: z.string() }))
})
const installedReleaseSchema = z.looseObject({ created_at: z.string() })

/** Published releases with an APK asset; malformed or phone-uninstallable entries are dropped. */
export function parsePersonalReleases(payload: unknown): PersonalRelease[] {
  return releaseListSchema.parse(payload).flatMap((entry) => {
    // One unsuitable entry (a draft, a desktop-only asset set) must not hide the rest.
    const parsed = installableReleaseSchema.safeParse(entry)
    const apk = parsed.success
      ? parsed.data.assets.find((asset) => asset.name.endsWith('.apk'))
      : null
    if (!parsed.success || !apk) {
      return []
    }
    return [
      {
        tag: parsed.data.tag_name,
        createdAt: parsed.data.created_at,
        pageUrl: parsed.data.html_url
      }
    ]
  })
}

/** The installed tag's release fixes the creation time the build order is judged against; null when GitHub knows no such release. */
async function fetchInstalledRelease(
  fetchImpl: Fetch,
  installedTag: string,
  signal: AbortSignal
): Promise<PersonalReleaseIdentity | null> {
  const reply = await fetchImpl(`${RELEASES_API}/tags/${encodeURIComponent(installedTag)}`, {
    signal
  })
  if (reply.status === 404) {
    return null
  }
  if (!reply.ok) {
    throw new Error(`installed release HTTP ${reply.status}`)
  }
  const parsed = installedReleaseSchema.parse(await reply.json())
  return { tag: installedTag, createdAt: parsed.created_at }
}

/** The newest personal release built after the installed tag's release, or null when up to date. */
export async function findNewestPersonalRelease(
  fetchImpl: Fetch,
  installedTag: string,
  signal: AbortSignal
): Promise<PersonalRelease | null> {
  const installed = await fetchInstalledRelease(fetchImpl, installedTag, signal)
  // Without the installed release's timestamp nothing can be ordered; stay quiet rather than offer a guess.
  if (installed === null) {
    return null
  }
  const listReply = await fetchImpl(RELEASES_API, { signal })
  if (!listReply.ok) {
    throw new Error(`releases HTTP ${listReply.status}`)
  }
  const candidates = parsePersonalReleases(await listReply.json())
    .filter((release) => release.tag.startsWith(PERSONAL_RELEASE_TAG_PREFIX))
    // A release with an unparseable timestamp has no build order; skip it rather than guess.
    .filter((release) => Number.isFinite(Date.parse(release.createdAt)))
    // GitHub orders the list by publish time while created_at is the build order, so re-sort.
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  return candidates.find((candidate) => isNewerPersonalRelease(candidate, installed)) ?? null
}

export function createPersonalReleaseUpdateSource(fetchImpl: Fetch): AppUpdateSource {
  return {
    async check(installedTag, signal): Promise<AppUpdateCheckResult> {
      const release = await findNewestPersonalRelease(fetchImpl, installedTag, signal)
      return release
        ? { kind: 'available', version: release.tag, url: release.pageUrl }
        : { kind: 'current' }
    }
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'

const {
  appMock,
  autoUpdaterMock,
  fetchLatestStableReleaseTagMock,
  fetchNewerReleaseTagsMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () =>
  (await import('./testing/updater-test-harness')).createUpdaterMocks()
)

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('../ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./linux-package/linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./releases/updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./nudges/nudge-campaign', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./releases/updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
// Keep the real release-readiness exports: its getReleaseDownloadUrl is the dual-repo
// builder whose personal-channel routing (dudupii releases) is under test here.
vi.mock('./releases/updater-release-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>())
}))
vi.mock('../local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('../local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

warmUpdaterModule()

describe('personal-channel update checks', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    appMock.getVersion.mockReturnValue('1.4.214-4e2f1a0b3')
    // Fix the clock so the last-check-at suppression of startup background checks is deterministic.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-23T12:00:00Z'))
  })

  it('pins the fork feed and bypasses semver gates for a newer personal release', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: ['personal-1.4.214-111112222'],
      state: 'ready'
    })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const send = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(updaterMainWindow(send), { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledOnce())
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith(
      '1.4.214-4e2f1a0b3',
      expect.anything(),
      expect.objectContaining({ includePrerelease: true })
    )
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/dudupii/orca/releases/download/personal-1.4.214-111112222'
    })
    // Build-order recency can pick a semver-lower rebuild; the updater must accept it.
    expect(autoUpdaterMock.allowDowngrade).toBe(true)
    expect(autoUpdaterMock.disableDifferentialDownload).toBe(true)
    expect(fetchLatestStableReleaseTagMock).not.toHaveBeenCalled()
  })

  it('offers a semver-lower same-base rebuild once electron-updater reports it', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: ['personal-1.4.214-111112222'],
      state: 'ready'
    })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.4.214-111112222' })
      })
      return Promise.resolve(undefined)
    })
    const send = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(updaterMainWindow(send), { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(send.mock.calls).toContainEqual([
        'updater:status',
        expect.objectContaining({ state: 'available', version: '1.4.214-111112222' })
      ])
    })
  })

  it('discards an update event for the version already running', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: ['personal-1.4.214-4e2f1a0b3'],
      state: 'ready'
    })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.4.214-4e2f1a0b3' })
      })
      return Promise.resolve(undefined)
    })
    const send = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(updaterMainWindow(send), { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(send.mock.calls).toContainEqual([
        'updater:status',
        expect.objectContaining({ state: 'not-available' })
      ])
    })
    expect(send.mock.calls).not.toContainEqual([
      'updater:status',
      expect.objectContaining({ state: 'available' })
    ])
  })

  it('reports up to date without ever consulting the official stable feed', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    const send = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(updaterMainWindow(send), { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(send.mock.calls).toContainEqual([
        'updater:status',
        expect.objectContaining({ state: 'not-available', userInitiated: true })
      ])
    })
    expect(fetchLatestStableReleaseTagMock).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })
})

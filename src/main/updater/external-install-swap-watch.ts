import { stat } from 'node:fs/promises'
import { app, dialog } from 'electron'

import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { translateMain } from '../i18n/main-i18n'
import { relaunchApp } from '../startup/quit/app-relaunch'
import { quitProcess } from '../startup/quit/process-quit-request'

// Package installs can replace the running app's files (deb/rpm upgrades, manual installers).
// The running instance keeps its in-memory code, but a later lazy chunk then loads from the new
// install, and the renderer reloads into a version the running main cannot pair with — the field
// incident bricked the window for 21 minutes. Detect the swap and ask for the restart the new
// install already needs, on the native surface a bricked renderer cannot suppress.
const EXTERNAL_INSTALL_SWAP_POLL_MS = 30_000

export type ExternalInstallSwapWatch = { stop: () => void }

export type ExternalInstallSwapWatchDeps = {
  /** Defaults to app.isPackaged; a dev tree churns its sources, not an install. */
  isPackaged?: boolean
  /** Defaults to app.getAppPath(); packaged, that is the app.asar lazy chunks load from. */
  appPath?: string
  pollIntervalMs?: number
  statFile?: (path: string) => Promise<{ ino: number; size: number }>
  /** Linux package managers replace files under a live process; mac/win updaters coordinate the swap themselves. */
  showRestartPrompt?: boolean
  presentPrompt?: () => Promise<boolean>
  restart?: () => void
}

export function startExternalInstallSwapWatch(
  deps: ExternalInstallSwapWatchDeps = {}
): ExternalInstallSwapWatch {
  const isPackaged = deps.isPackaged ?? app.isPackaged
  const appPath = deps.appPath ?? app.getAppPath()
  const pollIntervalMs = deps.pollIntervalMs ?? EXTERNAL_INSTALL_SWAP_POLL_MS
  const statFile =
    deps.statFile ??
    (async (path: string) => {
      const info = await stat(path)
      return { ino: info.ino, size: info.size }
    })
  const showRestartPrompt = deps.showRestartPrompt ?? process.platform === 'linux'
  const presentPrompt = deps.presentPrompt ?? presentDefaultPrompt
  const restart = deps.restart ?? defaultRestart

  if (!isPackaged) {
    return { stop: () => undefined }
  }

  let baseline: { ino: number; size: number } | null = null
  let stopped = false

  const check = async (): Promise<void> => {
    if (stopped) {
      return
    }
    let current: { ino: number; size: number }
    try {
      current = await statFile(appPath)
    } catch {
      // dpkg unlinks before writing; a missing file mid-install is not evidence of a swap.
      return
    }
    if (stopped) {
      return
    }
    if (!baseline) {
      baseline = current
      return
    }
    if (current.ino === baseline.ino && current.size === baseline.size) {
      return
    }
    stopped = true
    recordDurableCrashBreadcrumb('external_install_swapped_under_running_instance', {
      // Sizes only: breadcrumbs stay path-free, and a same-content reinstall still deserves a restart.
      priorSizeBytes: baseline.size,
      currentSizeBytes: current.size,
      promptShown: showRestartPrompt
    })
    console.warn('[updater] Install files changed under the running instance; restart required')
    if (showRestartPrompt && (await presentPrompt().catch(() => false))) {
      restart()
    }
  }

  void check()
  const poll = setInterval(() => void check(), pollIntervalMs)
  poll.unref?.()
  return {
    stop: () => {
      stopped = true
      clearInterval(poll)
    }
  }
}

async function presentDefaultPrompt(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: [
      translateMain('externalInstall.restartNow', 'Restart now'),
      translateMain('externalInstall.later', 'Later')
    ],
    defaultId: 0,
    cancelId: 1,
    title: translateMain('externalInstall.title', 'Orca was updated'),
    message: translateMain(
      'externalInstall.swapMessage',
      'Orca was updated while this instance was running.'
    ),
    detail: translateMain(
      'externalInstall.swapDetail',
      'Restart to load the update. Until then this window may run stale code or fail to open some pages.'
    )
  })
  return response === 0
}

function defaultRestart(): void {
  relaunchApp('external-install')
  quitProcess()
}

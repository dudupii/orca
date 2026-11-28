import { app } from 'electron'

import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from '../../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import type { MainWindowLoadObserver } from '../main-window/main-window-contracts'
import { mainWindowLoadErrorCode } from './main-window-load-error-code'

// A document can finish loading and never bootstrap. After an install is swapped under a running
// instance, the fresh renderer fetches chunks the running main cannot pair with and goes silent
// before its first breadcrumb; the field incident ran 21 minutes with zero renderer evidence and
// no recovery, because process-gone never fired. Silence itself is the diagnostic: name it, then
// reload once.
export const RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS = 20_000
// Vite serves chunks lazily, so a dev document can legitimately signal later than a packaged one.
export const RENDERER_BOOTSTRAP_SILENCE_DEV_TIMEOUT_MS = 90_000
// One automatic reload bounds the self-heal; repeated silence keeps evidence without a loop.
const MAX_AUTO_RELOADS_PER_WINDOW = 1
const SILENCE_BREADCRUMB_COALESCE_MS = 30_000

// Any breadcrumb proves the document reached its app shell far enough to emit evidence, so the
// cheapest renderer→main signal cancels the arm. Keyed by webContents so guest breadcrumbs
// cannot cancel the main window's arm.
const silenceCancelByWebContentsId = new Map<number, () => void>()

/** Called from the breadcrumb IPC path for every renderer message that reaches main. */
export function noteRendererLivenessSignal(webContentsId: number): void {
  silenceCancelByWebContentsId.get(webContentsId)?.()
}

export type RendererBootstrapSilenceWatchdog = {
  /** Arms after a load lands; a fresh document that signals in time disarms silently. */
  armAfterLoad: () => void
  /** A renderer death in the meantime hands the next load to crash recovery. */
  cancelArm: () => void
  dispose: () => void
}

export function createRendererBootstrapSilenceWatchdog(args: {
  rendererWebContentsId: number
  /** Crash recovery owns the next load while a recovery reload is scheduled or in flight. */
  isRecoveryPending: () => boolean
  shouldAbort: () => boolean
  reloadMainWindow: (observer: MainWindowLoadObserver) => void
  /** Marks the reload so a death under it is teardown, not a crash, and PTYs survive it. */
  markReloadExpected: () => void
}): RendererBootstrapSilenceWatchdog {
  const {
    rendererWebContentsId,
    isRecoveryPending,
    shouldAbort,
    reloadMainWindow,
    markReloadExpected
  } = args
  let timer: ReturnType<typeof setTimeout> | null = null
  let silentDocuments = 0
  let autoReloadsUsed = 0

  const budgetMs = (): number =>
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? RENDERER_BOOTSTRAP_SILENCE_DEV_TIMEOUT_MS
      : RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS

  function cancel(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (silenceCancelByWebContentsId.get(rendererWebContentsId) === cancel) {
      silenceCancelByWebContentsId.delete(rendererWebContentsId)
    }
  }

  const onSilence = (): void => {
    timer = null
    silenceCancelByWebContentsId.delete(rendererWebContentsId)
    if (shouldAbort()) {
      return
    }
    // A crash scheduled in the meantime owns the next load; its recovery breadcrumbs cover this.
    if (isRecoveryPending()) {
      return
    }
    silentDocuments += 1
    recordCoalescedDurableCrashBreadcrumb({
      name: 'renderer_bootstrap_silent',
      data: {
        silentDocuments,
        ...(autoReloadsUsed > 0 ? { afterAutoReload: true } : {})
      },
      coalesceKey: String(rendererWebContentsId),
      minIntervalMs: SILENCE_BREADCRUMB_COALESCE_MS
    })
    console.warn(
      `[window] Renderer document loaded but never signalled (${silentDocuments}); bootstrap silent`
    )
    if (autoReloadsUsed >= MAX_AUTO_RELOADS_PER_WINDOW) {
      return
    }
    autoReloadsUsed += 1
    recordDurableCrashBreadcrumb('renderer_bootstrap_silent_reload', {
      attempt: autoReloadsUsed
    })
    markReloadExpected()
    reloadMainWindow({
      onLoaded: () =>
        recordDurableCrashBreadcrumb('renderer_bootstrap_silent_reload_loaded', {
          attempt: autoReloadsUsed
        }),
      onError: (error) =>
        recordDurableCrashBreadcrumb('renderer_bootstrap_silent_reload_failed', {
          attempt: autoReloadsUsed,
          errorCode: mainWindowLoadErrorCode(error)
        })
    })
  }

  return {
    armAfterLoad: () => {
      if (shouldAbort()) {
        return
      }
      cancel()
      silenceCancelByWebContentsId.set(rendererWebContentsId, cancel)
      timer = setTimeout(onSilence, budgetMs())
      timer.unref?.()
    },
    cancelArm: cancel,
    dispose: () => {
      cancel()
    }
  }
}

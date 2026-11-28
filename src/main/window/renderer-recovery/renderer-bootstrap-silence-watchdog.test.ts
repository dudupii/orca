import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { recordCoalescedMock, recordDurableMock } = vi.hoisted(() => ({
  recordCoalescedMock: vi.fn(),
  recordDurableMock: vi.fn()
}))

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('../../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordCoalescedDurableCrashBreadcrumb: recordCoalescedMock,
  recordDurableCrashBreadcrumb: recordDurableMock
}))

import {
  createRendererBootstrapSilenceWatchdog,
  noteRendererLivenessSignal,
  RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS
} from './renderer-bootstrap-silence-watchdog'

function build(args?: { isRecoveryPending?: () => boolean; shouldAbort?: () => boolean }) {
  const reloadMainWindow = vi.fn()
  const markReloadExpected = vi.fn()
  const watchdog = createRendererBootstrapSilenceWatchdog({
    rendererWebContentsId: 42,
    isRecoveryPending: args?.isRecoveryPending ?? (() => false),
    shouldAbort: args?.shouldAbort ?? (() => false),
    reloadMainWindow,
    markReloadExpected
  })
  return { watchdog, reloadMainWindow, markReloadExpected }
}

beforeEach(() => {
  vi.useFakeTimers()
  recordCoalescedMock.mockReset()
  recordDurableMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createRendererBootstrapSilenceWatchdog', () => {
  it('disarms silently when any renderer breadcrumb reaches main', async () => {
    const { watchdog, reloadMainWindow, markReloadExpected } = build()
    watchdog.armAfterLoad()
    noteRendererLivenessSignal(42)
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS + 1_000)
    expect(recordCoalescedMock).not.toHaveBeenCalled()
    expect(reloadMainWindow).not.toHaveBeenCalled()
    expect(markReloadExpected).not.toHaveBeenCalled()
    watchdog.dispose()
  })

  it('ignores liveness signals from other webContents', async () => {
    const { watchdog } = build()
    watchdog.armAfterLoad()
    noteRendererLivenessSignal(7)
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS)
    expect(recordCoalescedMock).toHaveBeenCalledTimes(1)
    watchdog.dispose()
  })

  it('records evidence and reloads once when the document never signals', async () => {
    const { watchdog, reloadMainWindow, markReloadExpected } = build()
    watchdog.armAfterLoad()
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS)
    expect(recordCoalescedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'renderer_bootstrap_silent',
        data: { silentDocuments: 1 }
      })
    )
    expect(markReloadExpected).toHaveBeenCalledTimes(1)
    expect(reloadMainWindow).toHaveBeenCalledTimes(1)
    const observer = reloadMainWindow.mock.calls[0][0]
    observer.onLoaded?.()
    expect(recordDurableMock).toHaveBeenCalledWith('renderer_bootstrap_silent_reload_loaded', {
      attempt: 1
    })
    watchdog.dispose()
  })

  it('names the reload failure with its load error code', async () => {
    const { watchdog, reloadMainWindow } = build()
    watchdog.armAfterLoad()
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS)
    const observer = reloadMainWindow.mock.calls[0][0]
    observer.onError?.(new Error('failed to load'))
    expect(recordDurableMock).toHaveBeenCalledWith(
      'renderer_bootstrap_silent_reload_failed',
      expect.objectContaining({ attempt: 1 })
    )
    watchdog.dispose()
  })

  it('caps the automatic reload after the first silent document', async () => {
    const { watchdog, reloadMainWindow } = build()
    watchdog.armAfterLoad()
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS)
    watchdog.armAfterLoad()
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS)
    expect(recordCoalescedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'renderer_bootstrap_silent',
        data: { silentDocuments: 2, afterAutoReload: true }
      })
    )
    expect(reloadMainWindow).toHaveBeenCalledTimes(1)
    watchdog.dispose()
  })

  it('leaves the next load to crash recovery while a recovery reload is pending', async () => {
    const { watchdog, reloadMainWindow } = build({ isRecoveryPending: () => true })
    watchdog.armAfterLoad()
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS)
    expect(recordCoalescedMock).not.toHaveBeenCalled()
    expect(reloadMainWindow).not.toHaveBeenCalled()
    watchdog.dispose()
  })

  it('does nothing once the window is aborting', async () => {
    const { watchdog, reloadMainWindow } = build({ shouldAbort: () => true })
    watchdog.armAfterLoad()
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS)
    expect(recordCoalescedMock).not.toHaveBeenCalled()
    expect(reloadMainWindow).not.toHaveBeenCalled()
  })

  it('restarts the budget when a later load re-arms', async () => {
    const { watchdog, reloadMainWindow } = build()
    watchdog.armAfterLoad()
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS / 2)
    watchdog.armAfterLoad()
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS / 2)
    expect(reloadMainWindow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RENDERER_BOOTSTRAP_SILENCE_TIMEOUT_MS / 2)
    expect(reloadMainWindow).toHaveBeenCalledTimes(1)
    watchdog.dispose()
  })
})

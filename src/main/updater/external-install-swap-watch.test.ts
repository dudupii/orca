import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  recordDurableMock,
  presentPromptMock,
  relaunchAppMock,
  quitProcessMock,
  showMessageBoxMock
} = vi.hoisted(() => ({
  recordDurableMock: vi.fn(),
  presentPromptMock: vi.fn(),
  relaunchAppMock: vi.fn(),
  quitProcessMock: vi.fn(),
  showMessageBoxMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => '/opt/Orca/resources/app.asar' },
  dialog: { showMessageBox: showMessageBoxMock }
}))
vi.mock('../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableMock
}))
vi.mock('../i18n/main-i18n', () => ({
  translateMain: vi.fn((_key: string, fallback: string) => fallback)
}))
vi.mock('../startup/quit/app-relaunch', () => ({ relaunchApp: relaunchAppMock }))
vi.mock('../startup/quit/process-quit-request', () => ({ quitProcess: quitProcessMock }))

import { startExternalInstallSwapWatch } from './external-install-swap-watch'

const POLL_MS = 1_000

function buildWatch(
  statResults: ({ ino: number; size: number } | Error)[],
  args?: {
    showRestartPrompt?: boolean
    presentPrompt?: () => Promise<boolean>
    isPackaged?: boolean
  }
) {
  let call = 0
  const statFile = vi.fn(async () => {
    const result = statResults[Math.min(call, statResults.length - 1)]
    call += 1
    if (result instanceof Error) {
      throw result
    }
    return result
  })
  const watch = startExternalInstallSwapWatch({
    appPath: '/opt/Orca/resources/app.asar',
    pollIntervalMs: POLL_MS,
    statFile,
    presentPrompt: args?.presentPrompt ?? presentPromptMock,
    ...(args?.isPackaged === undefined ? {} : { isPackaged: args.isPackaged }),
    ...(args?.showRestartPrompt === undefined ? {} : { showRestartPrompt: args.showRestartPrompt })
  })
  return { watch, statFile }
}

beforeEach(() => {
  vi.useFakeTimers()
  recordDurableMock.mockReset()
  presentPromptMock.mockReset().mockResolvedValue(true)
  relaunchAppMock.mockReset()
  quitProcessMock.mockReset()
  showMessageBoxMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startExternalInstallSwapWatch', () => {
  it('records the swap and restarts through the relaunch and graceful quit when accepted', async () => {
    buildWatch([
      { ino: 1, size: 100 },
      { ino: 2, size: 200 }
    ])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(recordDurableMock).toHaveBeenCalledWith(
      'external_install_swapped_under_running_instance',
      { priorSizeBytes: 100, currentSizeBytes: 200, promptShown: true }
    )
    expect(presentPromptMock).toHaveBeenCalledTimes(1)
    expect(relaunchAppMock).toHaveBeenCalledWith('external-install')
    expect(quitProcessMock).toHaveBeenCalledTimes(1)
  })

  it('waits out a mid-install missing file and still detects the swap after it', async () => {
    buildWatch([
      { ino: 1, size: 100 },
      new Error('ENOENT: no such file or directory'),
      { ino: 2, size: 200 }
    ])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(recordDurableMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(recordDurableMock).toHaveBeenCalledTimes(1)
    expect(relaunchAppMock).toHaveBeenCalledTimes(1)
  })

  it('records evidence but does not restart when the prompt is declined', async () => {
    buildWatch(
      [
        { ino: 1, size: 100 },
        { ino: 2, size: 200 }
      ],
      {
        presentPrompt: () => Promise.resolve(false)
      }
    )
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(recordDurableMock).toHaveBeenCalledTimes(1)
    expect(relaunchAppMock).not.toHaveBeenCalled()
    expect(quitProcessMock).not.toHaveBeenCalled()
  })

  it('stops checking after the first detected swap', async () => {
    const { statFile } = buildWatch([
      { ino: 1, size: 100 },
      { ino: 2, size: 200 }
    ])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    const checksAfterSwap = statFile.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(statFile.mock.calls.length).toBe(checksAfterSwap)
    expect(recordDurableMock).toHaveBeenCalledTimes(1)
  })

  it('stays quiet while the install file matches its startup identity', async () => {
    buildWatch([
      { ino: 1, size: 100 },
      { ino: 1, size: 100 },
      { ino: 1, size: 100 }
    ])
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(recordDurableMock).not.toHaveBeenCalled()
    expect(presentPromptMock).not.toHaveBeenCalled()
  })

  it('is a no-op outside a packaged install', async () => {
    const { statFile } = buildWatch([{ ino: 1, size: 100 }], { isPackaged: false })
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    expect(statFile).not.toHaveBeenCalled()
    expect(recordDurableMock).not.toHaveBeenCalled()
  })

  it('stops checking once stopped', async () => {
    const { watch, statFile } = buildWatch([{ ino: 1, size: 100 }])
    // The startup baseline check legitimately runs before stop; no further checks may follow.
    expect(statFile).toHaveBeenCalledTimes(1)
    watch.stop()
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    expect(statFile).toHaveBeenCalledTimes(1)
  })
})

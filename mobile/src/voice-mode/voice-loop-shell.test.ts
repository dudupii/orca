import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VoiceLoopShell,
  type VoiceLoopNotice,
  type VoiceLoopSendOutcome,
  type VoiceLoopShellDeps,
  type VoiceLoopTranscriptRead,
  type VoiceLoopView
} from './voice-loop-shell'

// The machine's own silence window; the shell adds the response-delay window on top of it.
const SILENCE_WINDOW_MS = 1200
const RESPONSE_DELAY_MS = 1500
const READ_INTERVAL_MS = 100

type Harness = {
  shell: VoiceLoopShell
  deps: VoiceLoopShellDeps
  views: VoiceLoopView[]
  notices: VoiceLoopNotice[]
  setRead: (read: VoiceLoopTranscriptRead) => void
}

function createHarness(overrides: Partial<VoiceLoopShellDeps> = {}): Harness {
  const views: VoiceLoopView[] = []
  const notices: VoiceLoopNotice[] = []
  let read: VoiceLoopTranscriptRead = { revision: 0, committed: '', tentative: '', failure: null }
  const deps: VoiceLoopShellDeps = {
    now: () => Date.now(),
    startSpeech: vi.fn(async () => ({ started: true, busy: false })),
    cancelSpeech: vi.fn(),
    readSpeech: vi.fn(async () => read),
    openMic: vi.fn(async () => true),
    closeMic: vi.fn(),
    holdScreen: vi.fn(),
    releaseScreen: vi.fn(),
    send: vi.fn(async (): Promise<VoiceLoopSendOutcome> => ({ sent: true, reply: 'Done' })),
    responseDelayMs: () => RESPONSE_DELAY_MS,
    onState: (view) => views.push(view),
    onNotice: (notice) => notices.push(notice),
    readIntervalMs: READ_INTERVAL_MS,
    ...overrides
  }
  return {
    shell: new VoiceLoopShell(deps),
    deps,
    views,
    notices,
    setRead: (next) => {
      read = next
    }
  }
}

// Speaks one committed utterance and runs the clock out to the moment its send commits.
async function speakAndFinalize(harness: Harness, utterance: string): Promise<void> {
  harness.setRead({ revision: 1, committed: utterance, tentative: '', failure: null })
  await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
  await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS + RESPONSE_DELAY_MS)
}

describe('VoiceLoopShell', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('routes a finalized utterance through the delay window into a silent reply and back to listening', async () => {
    const harness = createHarness()
    await harness.shell.start()
    expect(harness.views.at(-1)?.route).toBe('listening')

    harness.setRead({ revision: 1, committed: 'hello', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(harness.views.at(-1)?.transcript).toBe('hello')

    // Quiet for the machine's silence window: the utterance finalizes and waits, revocable.
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS)
    const waiting = harness.views.at(-1)
    expect(waiting?.pending).toBe('hello')
    expect(waiting?.route).toBe('listening')

    // The response delay lapses untapped: the send commits with no manual press.
    await vi.advanceTimersByTimeAsync(RESPONSE_DELAY_MS)
    expect(harness.deps.send).toHaveBeenCalledOnce()
    expect(vi.mocked(harness.deps.send).mock.calls[0][0]).toBe('hello')
    const settled = harness.views.at(-1)
    expect(settled?.route).toBe('listening')
    expect(settled?.reply).toBe('Done')
    expect(settled?.pending).toBeNull()
  })

  it('a tap inside the delay window cancels the send and stays listening until speech resumes', async () => {
    const harness = createHarness()
    await harness.shell.start()
    harness.setRead({ revision: 1, committed: 'hello', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS + SILENCE_WINDOW_MS)
    expect(harness.views.at(-1)?.pending).toBe('hello')

    harness.shell.tapPending()
    expect(harness.views.at(-1)?.pending).toBeNull()

    // The cancel holds: quiet alone never re-arms the wait.
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS * 5)
    expect(harness.deps.send).not.toHaveBeenCalled()

    // Speech resumes, so the next finalize carries both chunks and waits again.
    harness.setRead({ revision: 2, committed: 'hello again', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS + SILENCE_WINDOW_MS)
    expect(harness.views.at(-1)?.pending).toBe('hello again')
    await vi.advanceTimersByTimeAsync(RESPONSE_DELAY_MS)
    expect(vi.mocked(harness.deps.send).mock.calls[0][0]).toBe('hello again')
  })

  it('cannot revoke a send once the delay window has lapsed', async () => {
    const harness = createHarness()
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    expect(harness.deps.send).toHaveBeenCalledOnce()

    harness.shell.tapPending()
    expect(harness.deps.send).toHaveBeenCalledOnce()
    expect(harness.views.at(-1)?.route).toBe('listening')
  })

  it('refuses a mic held by another session with a visible notice, never queueing or retrying', async () => {
    const startSpeech = vi.fn(async () => ({ started: false, busy: true }))
    const harness = createHarness({ startSpeech })
    await harness.shell.start()

    expect(harness.notices).toEqual(['mic-exclusive'])
    expect(harness.deps.readSpeech).not.toHaveBeenCalled()
    // Another session's recognizer is left running and nothing of ours was held.
    expect(harness.deps.cancelSpeech).not.toHaveBeenCalled()
    expect(harness.deps.openMic).not.toHaveBeenCalled()
    expect(harness.deps.holdScreen).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS * 5)
    expect(harness.deps.readSpeech).not.toHaveBeenCalled()
    expect(harness.notices).toEqual(['mic-exclusive'])
  })

  it('shows live tentative words without sending them', async () => {
    const harness = createHarness()
    await harness.shell.start()
    harness.setRead({ revision: 1, committed: '', tentative: 'hey', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(harness.views.at(-1)?.transcript).toBe('hey')

    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS * 3)
    expect(harness.views.at(-1)?.pending).toBeNull()
    expect(harness.deps.send).not.toHaveBeenCalled()
  })

  it('a speech failure mid-loop exits cleanly with a visible notice', async () => {
    const harness = createHarness()
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')

    harness.setRead({ revision: 2, committed: 'hello', tentative: '', failure: 'failed' })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)

    expect(harness.notices).toEqual(['speech-failed'])
    expect(harness.views.at(-1)?.route).toBe('closed')
    expect(harness.deps.cancelSpeech).toHaveBeenCalledOnce()
    expect(harness.deps.closeMic).toHaveBeenCalledOnce()
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a send the chat refuses exits voice mode with a notice', async () => {
    const harness = createHarness({
      send: vi.fn(async (): Promise<VoiceLoopSendOutcome> => ({ sent: false }))
    })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')

    expect(harness.notices).toEqual(['send-failed'])
    expect(harness.views.at(-1)?.route).toBe('closed')
    expect(harness.deps.closeMic).toHaveBeenCalledOnce()
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()
  })

  it('a refused microphone open cancels the armed recognizer and reports it', async () => {
    const harness = createHarness({ openMic: vi.fn(async () => false) })
    await harness.shell.start()

    expect(harness.notices).toEqual(['mic-unavailable'])
    expect(harness.deps.cancelSpeech).toHaveBeenCalledOnce()
    // The screen was held for the open; the refusal gives it back.
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()
    expect(harness.deps.closeMic).not.toHaveBeenCalled()
    expect(harness.deps.readSpeech).not.toHaveBeenCalled()
  })

  it('exit settles the loop terminal, releases mic and screen, and leaves nothing scheduled', async () => {
    const harness = createHarness()
    await harness.shell.start()
    harness.setRead({ revision: 1, committed: 'hello', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)

    harness.shell.exit()

    expect(harness.views.at(-1)?.route).toBe('closed')
    expect(harness.deps.cancelSpeech).toHaveBeenCalledOnce()
    expect(harness.deps.closeMic).toHaveBeenCalledOnce()
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS * 5)
    expect(harness.deps.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    // Exiting twice releases nothing a second time.
    harness.shell.exit()
    expect(harness.deps.closeMic).toHaveBeenCalledOnce()
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()
  })
})

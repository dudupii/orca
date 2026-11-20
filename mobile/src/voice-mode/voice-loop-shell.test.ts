import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceLoopShell } from './voice-loop-shell'
import type {
  VoiceLoopNotice,
  VoiceLoopSendOutcome,
  VoiceLoopShellDeps,
  VoiceLoopTranscriptRead,
  VoiceLoopView
} from './voice-loop-shell-contract'

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
    steer: vi.fn(async () => ({ steered: true })),
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

// A send that never settles keeps the loop waiting on its running turn, as a real turn would.
function hangSend(): {
  send: VoiceLoopShellDeps['send']
  resolve: (outcome: VoiceLoopSendOutcome) => void
} {
  let settle: (outcome: VoiceLoopSendOutcome) => void = () => {}
  const send = vi.fn(
    () =>
      new Promise<VoiceLoopSendOutcome>((resolve) => {
        settle = resolve
      })
  )
  return { send, resolve: (outcome) => settle(outcome) }
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

  it('delivers mid-turn speech through the steer seam while the turn runs, and its reply ends it', async () => {
    const hanging = hangSend()
    const steer = vi.fn(async (_text: string) => ({ steered: true }))
    const harness = createHarness({ send: hanging.send, steer })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    expect(harness.views.at(-1)?.route).toBe('thinking')
    // The turn the send started is still running; nothing has steered it.
    expect(steer).not.toHaveBeenCalled()

    harness.setRead({ revision: 2, committed: 'hello no wait', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(harness.views.at(-1)?.transcript).toBe('no wait')

    // The held steering waits out the same revocable window a send does.
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS)
    expect(harness.views.at(-1)?.pending).toBe('no wait')
    await vi.advanceTimersByTimeAsync(RESPONSE_DELAY_MS)
    expect(steer).toHaveBeenCalledOnce()
    expect(steer.mock.calls[0][0]).toBe('no wait')
    // The running turn was rerouted, not re-sent.
    expect(harness.deps.send).toHaveBeenCalledOnce()
    expect(harness.views.at(-1)?.route).toBe('thinking')

    hanging.resolve({ sent: true, reply: 'Done' })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(harness.views.at(-1)?.route).toBe('listening')
    expect(harness.views.at(-1)?.reply).toBe('Done')
  })

  it('a tap on the waiting steering hands it to the running turn early, exactly once', async () => {
    const hanging = hangSend()
    const steer = vi.fn(async (_text: string) => ({ steered: true }))
    const harness = createHarness({ send: hanging.send, steer })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    harness.setRead({ revision: 2, committed: 'hello go left', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS + SILENCE_WINDOW_MS)
    expect(harness.views.at(-1)?.pending).toBe('go left')

    harness.shell.tapPending()
    expect(steer).toHaveBeenCalledOnce()
    expect(steer.mock.calls[0][0]).toBe('go left')
    expect(harness.views.at(-1)?.pending).toBeNull()

    // The flushed window never fires again, and quiet alone arms no new one.
    await vi.advanceTimersByTimeAsync(RESPONSE_DELAY_MS * 3)
    expect(steer).toHaveBeenCalledOnce()
    expect(harness.views.at(-1)?.route).toBe('thinking')
  })

  it('a steer the chat refuses exits voice mode with a notice', async () => {
    const hanging = hangSend()
    const steer = vi.fn(async (_text: string) => ({ steered: false }))
    const harness = createHarness({ send: hanging.send, steer })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    harness.setRead({ revision: 2, committed: 'hello stop', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS + SILENCE_WINDOW_MS + RESPONSE_DELAY_MS)

    expect(harness.notices).toEqual(['send-failed'])
    expect(harness.views.at(-1)?.route).toBe('closed')
    expect(harness.deps.closeMic).toHaveBeenCalledOnce()
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a reply that lands before the steering window closes drops the held words', async () => {
    const hanging = hangSend()
    const steer = vi.fn(async (_text: string) => ({ steered: true }))
    const harness = createHarness({ send: hanging.send, steer })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    harness.setRead({ revision: 2, committed: 'hello quieter', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS + SILENCE_WINDOW_MS)
    expect(harness.views.at(-1)?.pending).toBe('quieter')

    // The turn finishes first: the machine drops the late steering, and no window outlives it.
    hanging.resolve({ sent: true, reply: 'Done' })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(harness.views.at(-1)?.pending).toBeNull()
    expect(harness.views.at(-1)?.route).toBe('listening')
    await vi.advanceTimersByTimeAsync(RESPONSE_DELAY_MS * 3)
    expect(steer).not.toHaveBeenCalled()
    expect(harness.deps.send).toHaveBeenCalledOnce()
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

  it('an exit while the microphone open is pending closes the late open exactly once', async () => {
    let resolveOpen: (opened: boolean) => void = () => {}
    const openMic = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = resolve
        })
    )
    const harness = createHarness({ openMic })
    const starting = harness.shell.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openMic).toHaveBeenCalledOnce()

    // The exit could not close a microphone that had not opened yet.
    harness.shell.exit()
    expect(harness.deps.cancelSpeech).toHaveBeenCalledOnce()
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()
    expect(harness.deps.closeMic).not.toHaveBeenCalled()

    // The open succeeds anyway: the late success belongs to the cancelled start, closed once.
    resolveOpen(true)
    await starting
    expect(harness.deps.closeMic).toHaveBeenCalledOnce()
    expect(harness.deps.cancelSpeech).toHaveBeenCalledOnce()
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a throwing microphone open reports unavailable, releases what it held, and settles closed', async () => {
    const harness = createHarness({
      openMic: vi.fn(async () => {
        throw new Error('bridge refused')
      })
    })
    await harness.shell.start()

    expect(harness.notices).toEqual(['mic-unavailable'])
    expect(harness.deps.cancelSpeech).toHaveBeenCalledOnce()
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()
    expect(harness.deps.closeMic).not.toHaveBeenCalled()
    expect(harness.views.at(-1)?.route).toBe('closed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a throwing recognizer start reports unavailable and acquires nothing', async () => {
    const harness = createHarness({
      startSpeech: vi.fn(async () => {
        throw new Error('bridge refused')
      })
    })
    await harness.shell.start()

    expect(harness.notices).toEqual(['mic-unavailable'])
    expect(harness.deps.holdScreen).not.toHaveBeenCalled()
    expect(harness.deps.openMic).not.toHaveBeenCalled()
    expect(harness.views.at(-1)?.route).toBe('closed')
  })
})

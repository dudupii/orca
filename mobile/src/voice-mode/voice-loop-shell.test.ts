import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceLoopShell } from './voice-loop-shell'
import type {
  VoiceLoopNotice,
  VoiceLoopSendOutcome,
  VoiceLoopShellDeps,
  VoiceLoopTranscriptRead,
  VoiceLoopView
} from './voice-loop-shell-contract'
import type {
  VoiceReadout,
  VoiceReadoutBriefing,
  VoiceReadoutEnd,
  VoiceSpeakBroadcast
} from './voice-readout-contract'

// The machine's own silence window; the shell adds the response-delay window on top of it.
const SILENCE_WINDOW_MS = 1200
const RESPONSE_DELAY_MS = 1500
const READ_INTERVAL_MS = 100
// How long the fake readout's playback runs before it ends on its own.
const PLAYBACK_MS = 300

// A readout the tests drive by hand: plays end after PLAYBACK_MS unless a stop settles them first,
// mirroring the real seam, where a stop ends the poll's claim early.
type FakeReadout = VoiceReadout & {
  readonly beginTurns: number
  readonly briefings: VoiceSpeakBroadcast[]
  readonly plays: { text: string; locale: string | null }[]
  readonly stops: number
  /** What settleBriefing hands the shell; beginTurn clears it, briefingArrived sets it. */
  nextBriefing: VoiceReadoutBriefing | null
}

function fakeReadout(): FakeReadout {
  let beginTurns = 0
  let stops = 0
  const briefings: VoiceSpeakBroadcast[] = []
  const plays: { text: string; locale: string | null }[] = []
  const pending: {
    resolve: (end: VoiceReadoutEnd) => void
    timer: ReturnType<typeof setTimeout>
  }[] = []
  let nextBriefing: VoiceReadoutBriefing | null = null
  return {
    get beginTurns() {
      return beginTurns
    },
    get briefings() {
      return briefings
    },
    get plays() {
      return plays
    },
    get stops() {
      return stops
    },
    get nextBriefing() {
      return nextBriefing
    },
    set nextBriefing(value: VoiceReadoutBriefing | null) {
      nextBriefing = value
    },
    beginTurn: () => {
      beginTurns += 1
      nextBriefing = null
    },
    briefingArrived: (broadcast) => {
      briefings.push(broadcast)
      nextBriefing = { text: broadcast.text, lang: broadcast.lang }
    },
    settleBriefing: () => nextBriefing,
    play: (utterance) => {
      plays.push({ text: utterance.text, locale: utterance.locale })
      return new Promise<VoiceReadoutEnd>((resolve) => {
        const entry = {
          resolve,
          timer: setTimeout(() => {
            pending.splice(pending.indexOf(entry), 1)
            resolve('done')
          }, PLAYBACK_MS)
        }
        pending.push(entry)
      })
    },
    stop: () => {
      stops += 1
      for (const entry of pending.splice(0)) {
        clearTimeout(entry.timer)
        entry.resolve('stopped')
      }
    }
  }
}

type Harness = {
  shell: VoiceLoopShell
  deps: VoiceLoopShellDeps
  readout: FakeReadout
  views: VoiceLoopView[]
  notices: VoiceLoopNotice[]
  setRead: (read: VoiceLoopTranscriptRead) => void
}

function createHarness(overrides: Partial<VoiceLoopShellDeps> = {}): Harness {
  const views: VoiceLoopView[] = []
  const notices: VoiceLoopNotice[] = []
  const readout = fakeReadout()
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
    readout,
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
    readout,
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

  it('routes a finalized utterance through the delay window into a spoken reply and back to listening', async () => {
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
    expect(harness.views.at(-1)?.route).toBe('speaking')
    // No briefing arrived, so the reply's own condensed prose is the readout.
    expect(harness.readout.plays).toEqual([{ text: 'Done', locale: null }])

    // Playback ends on its own: the loop returns to listening through the machine's own gate.
    await vi.advanceTimersByTimeAsync(PLAYBACK_MS)
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
    // The reply is speaking; the tap found no pending utterance to revoke.
    expect(harness.views.at(-1)?.route).toBe('speaking')
    await vi.advanceTimersByTimeAsync(PLAYBACK_MS)
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
    // T6's playback binding owns the reply: it speaks before the loop listens again.
    expect(harness.views.at(-1)?.route).toBe('speaking')
    expect(harness.views.at(-1)?.reply).toBe('Done')
    await vi.advanceTimersByTimeAsync(PLAYBACK_MS)
    expect(harness.views.at(-1)?.route).toBe('listening')
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
    // The reply's readout holds the loop in speaking; playback settling returns it to listening.
    expect(harness.views.at(-1)?.route).toBe('speaking')
    await vi.advanceTimersByTimeAsync(PLAYBACK_MS)
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

  it('speaks a briefing the model authored while the reply streamed, in its own language', async () => {
    let releaseSend: () => void = () => {}
    const send = vi.fn(
      () =>
        new Promise<VoiceLoopSendOutcome>((resolve) => {
          releaseSend = () => resolve({ sent: true, reply: 'Long reply. Not spoken.' })
        })
    )
    const harness = createHarness({ send })
    await harness.shell.start()
    harness.setRead({ revision: 1, committed: 'status', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS + SILENCE_WINDOW_MS)
    await vi.advanceTimersByTimeAsync(RESPONSE_DELAY_MS)
    expect(harness.deps.send).toHaveBeenCalledOnce()

    // The reply is still streaming when the model's speak broadcast lands.
    harness.readout.briefingArrived({ text: 'Checks pass.', lang: 'zh-CN', session: null })
    releaseSend()
    await vi.advanceTimersByTimeAsync(0)

    // The briefing is spoken verbatim with its language; the reply's prose never plays.
    expect(harness.readout.plays).toEqual([{ text: 'Checks pass.', locale: 'zh-CN' }])
    await vi.advanceTimersByTimeAsync(PLAYBACK_MS)
    expect(harness.views.at(-1)?.route).toBe('listening')
  })

  it('mutes the fallback prose when the setting is off, yet the loop keeps listening', async () => {
    const harness = createHarness({ fallbackReadout: false })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')

    expect(harness.deps.send).toHaveBeenCalledOnce()
    expect(harness.readout.plays).toEqual([])
    // No playback happened, so the loop is already listening again — never stalled.
    expect(harness.views.at(-1)?.route).toBe('listening')
    expect(harness.views.at(-1)?.reply).toBe('Done')
  })

  it('speech during playback barges in: playback stops and the new words own the next turn', async () => {
    const harness = createHarness()
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    expect(harness.views.at(-1)?.route).toBe('speaking')

    harness.setRead({ revision: 2, committed: 'hello wait', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)

    expect(harness.readout.stops).toBe(1)
    // The stop settled the playback; the loop is listening with the interrupting words buffered.
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.views.at(-1)?.route).toBe('listening')
    expect(harness.views.at(-1)?.transcript).toBe('wait')

    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS + RESPONSE_DELAY_MS)
    expect(vi.mocked(harness.deps.send).mock.calls[1][0]).toBe('wait')
  })

  it('speech during playback is refused while barge-in is off, so the readout plays to its end', async () => {
    const harness = createHarness({ bargeIn: false })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    expect(harness.views.at(-1)?.route).toBe('speaking')

    harness.setRead({ revision: 2, committed: 'hello wait', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)

    expect(harness.readout.stops).toBe(0)
    expect(harness.views.at(-1)?.route).toBe('speaking')
    // The words spoken over the playback were dropped, not buffered.
    expect(harness.views.at(-1)?.transcript).toBe('')

    await vi.advanceTimersByTimeAsync(PLAYBACK_MS)
    expect(harness.views.at(-1)?.route).toBe('listening')
  })

  it('a tap on the readout stops it even with barge-in off, and the loop keeps listening', async () => {
    const harness = createHarness({ bargeIn: false })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    expect(harness.views.at(-1)?.route).toBe('speaking')

    harness.shell.stopSpeaking()
    expect(harness.readout.stops).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.views.at(-1)?.route).toBe('listening')
  })

  it('a tap while not speaking stops nothing', async () => {
    const harness = createHarness()
    await harness.shell.start()
    harness.shell.stopSpeaking()
    expect(harness.readout.stops).toBe(0)
  })

  it('an exit during playback settles the stopped play without walking the machine anywhere', async () => {
    const harness = createHarness()
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    expect(harness.views.at(-1)?.route).toBe('speaking')

    harness.shell.exit()
    expect(harness.views.at(-1)?.route).toBe('closed')
    expect(harness.readout.stops).toBeGreaterThanOrEqual(1)

    // The stopped play's continuation finds the loop gone; nothing reopens or reschedules.
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS * 5)
    expect(harness.views.at(-1)?.route).toBe('closed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('parks a reply that lands while backgrounded, then serves the restore chime, playback and mic in order', async () => {
    const readout = fakeReadout()
    const tone = vi.fn()
    const reopenedWith = { plays: -1 }
    const openMic = vi.fn(async () => {
      reopenedWith.plays = readout.plays.length
      return true
    })
    const hanging = hangSend()
    const harness = createHarness({
      send: hanging.send,
      readout,
      openMic,
      tone: { play: tone }
    })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    expect(harness.views.at(-1)?.route).toBe('thinking')

    harness.shell.setForeground(false)
    expect(harness.deps.closeMic).toHaveBeenCalledOnce()
    const readsAtPause = vi.mocked(harness.deps.readSpeech).mock.calls.length
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS * 5)
    // The read cycle is suspended with the recognizer: nothing polls while away.
    expect(vi.mocked(harness.deps.readSpeech).mock.calls.length).toBe(readsAtPause)

    hanging.resolve({ sent: true, reply: 'Done while away.' })
    await vi.advanceTimersByTimeAsync(0)
    // The reply was accepted but plays nothing: its playback waits for the return.
    expect(harness.views.at(-1)?.route).toBe('speaking')
    expect(readout.plays).toEqual([])
    expect(tone).not.toHaveBeenCalled()

    harness.shell.setForeground(true)
    // Chime first, parked playback next, microphone only after both.
    expect(tone).toHaveBeenCalledOnce()
    expect(tone).toHaveBeenCalledWith('restore')
    expect(readout.plays).toEqual([{ text: 'Done while away.', locale: null }])
    expect(openMic).toHaveBeenCalledTimes(2)
    expect(reopenedWith.plays).toBe(1)
    expect(tone.mock.invocationCallOrder[0]).toBeLessThan(openMic.mock.invocationCallOrder[1])

    // The parked playback settles and walks the loop back to listening; the reads ride again.
    await vi.advanceTimersByTimeAsync(PLAYBACK_MS + READ_INTERVAL_MS * 2)
    expect(harness.views.at(-1)?.route).toBe('listening')
    expect(vi.mocked(harness.deps.readSpeech).mock.calls.length).toBeGreaterThan(readsAtPause)
  })

  it('restores a loop that advanced nothing: no chime, yet the microphone still reopens', async () => {
    const tone = vi.fn()
    const harness = createHarness({ tone: { play: tone } })
    await harness.shell.start()
    harness.setRead({ revision: 1, committed: 'held words', tentative: '', failure: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(harness.views.at(-1)?.transcript).toBe('held words')

    harness.shell.setForeground(false)
    harness.shell.setForeground(true)
    expect(tone).not.toHaveBeenCalled()
    expect(harness.readout.plays).toEqual([])
    expect(harness.deps.openMic).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(vi.mocked(harness.deps.readSpeech).mock.calls.length).toBeGreaterThan(1)
  })

  it('chimes for an away-straddling turn as its reply answers, before the playback starts', async () => {
    const readout = fakeReadout()
    const playsAtChime: number[] = []
    const tone = vi.fn(() => {
      playsAtChime.push(readout.plays.length)
    })
    const hanging = hangSend()
    const harness = createHarness({ send: hanging.send, readout, tone: { play: tone } })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')

    harness.shell.setForeground(false)
    harness.shell.setForeground(true)
    // The turn still ran at the return, so the restore itself stayed silent.
    expect(tone).not.toHaveBeenCalled()

    hanging.resolve({ sent: true, reply: 'The answer that outlasted the away.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(tone).toHaveBeenCalledOnce()
    expect(playsAtChime).toEqual([0])
    expect(readout.plays).toEqual([{ text: 'The answer that outlasted the away.', locale: null }])
  })

  it('stops a speaking loop when the app backgrounds, and the cut playback leaves it listening', async () => {
    const harness = createHarness()
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    expect(harness.views.at(-1)?.route).toBe('speaking')

    harness.shell.setForeground(false)
    // The machine's stopPlayback effect is honored through the shell, like a barge-in's is.
    expect(harness.readout.stops).toBe(1)
    expect(harness.views.at(-1)?.route).toBe('listening')
    await vi.advanceTimersByTimeAsync(0)
    // The stopped play's continuation finds the loop already listening; no playbackEnd misfires.
    expect(harness.views.at(-1)?.route).toBe('listening')

    harness.shell.setForeground(true)
    expect(harness.deps.openMic).toHaveBeenCalledTimes(2)
  })

  it('closes the loop with a notice when the restore cannot reopen the microphone', async () => {
    const openMic = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const harness = createHarness({ openMic })
    await harness.shell.start()
    harness.shell.setForeground(false)
    harness.shell.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.notices).toEqual(['mic-unavailable'])
    expect(harness.views.at(-1)?.route).toBe('closed')
    expect(harness.deps.cancelSpeech).toHaveBeenCalledOnce()
    expect(harness.deps.releaseScreen).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats a repeated leave or return as the same window: one close, one reopen', async () => {
    const harness = createHarness()
    await harness.shell.start()
    harness.shell.setForeground(false)
    harness.shell.setForeground(false)
    expect(harness.deps.closeMic).toHaveBeenCalledOnce()

    harness.shell.setForeground(true)
    harness.shell.setForeground(true)
    expect(harness.deps.openMic).toHaveBeenCalledTimes(2)
  })

  it('lets a repeated leave keep a parked reply speaking, for the restore to play', async () => {
    const readout = fakeReadout()
    const hanging = hangSend()
    const harness = createHarness({ send: hanging.send, readout })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    harness.shell.setForeground(false)
    hanging.resolve({ sent: true, reply: 'Parked.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.views.at(-1)?.route).toBe('speaking')

    // The platform fires a second non-active change (inactive after background) before the return;
    // the table must not cut a parked playback that never sounded.
    harness.shell.setForeground(false)
    expect(readout.stops).toBe(0)
    expect(harness.views.at(-1)?.route).toBe('speaking')

    harness.shell.setForeground(true)
    expect(readout.plays).toEqual([{ text: 'Parked.', locale: null }])
    await vi.advanceTimersByTimeAsync(PLAYBACK_MS)
    expect(harness.views.at(-1)?.route).toBe('listening')
  })

  it('drops a parked reply when the loop exits before the restore', async () => {
    const tone = vi.fn()
    const hanging = hangSend()
    const harness = createHarness({ send: hanging.send, tone: { play: tone } })
    await harness.shell.start()
    await speakAndFinalize(harness, 'hello')
    harness.shell.setForeground(false)
    hanging.resolve({ sent: true, reply: 'Never sounded.' })
    await vi.advanceTimersByTimeAsync(0)

    harness.shell.exit()
    harness.shell.setForeground(true)
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS * 5)
    expect(harness.views.at(-1)?.route).toBe('closed')
    expect(harness.readout.plays).toEqual([])
    expect(tone).not.toHaveBeenCalled()
    expect(harness.deps.openMic).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a leave while the recognizer start is pending brings the loop up paused: no mic, no reads, until the return', async () => {
    let resolveStart: (armed: { started: boolean; busy: boolean }) => void = () => {}
    const startSpeech = vi.fn(
      () =>
        new Promise<{ started: boolean; busy: boolean }>((resolve) => {
          resolveStart = resolve
        })
    )
    const harness = createHarness({ startSpeech })
    const starting = harness.shell.start()
    await vi.advanceTimersByTimeAsync(0)

    harness.shell.setForeground(false)
    resolveStart({ started: true, busy: false })
    await starting
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS * 5)
    // The loop is up and listening, but held: no microphone opened and nothing polled while away.
    expect(harness.deps.openMic).not.toHaveBeenCalled()
    expect(harness.deps.readSpeech).not.toHaveBeenCalled()
    expect(harness.views.at(-1)?.route).toBe('listening')

    harness.shell.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.deps.openMic).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(harness.deps.readSpeech).toHaveBeenCalledOnce()
  })

  it('a leave while the startup open is pending closes the late open and holds the loop for the return', async () => {
    let resolveOpen: (opened: boolean) => void = () => {}
    const openMic = vi
      .fn(async () => true)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveOpen = resolve
          })
      )
    const harness = createHarness({ openMic })
    const starting = harness.shell.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openMic).toHaveBeenCalledOnce()

    harness.shell.setForeground(false)
    resolveOpen(true)
    await starting
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS * 5)
    // The open won its race with the leave: the capture it started is closed, the reads suspended.
    expect(harness.deps.closeMic).toHaveBeenCalledOnce()
    expect(harness.deps.readSpeech).not.toHaveBeenCalled()
    expect(harness.views.at(-1)?.route).toBe('listening')

    harness.shell.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(openMic).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(vi.mocked(harness.deps.readSpeech).mock.calls.length).toBeGreaterThan(0)
  })

  it('a return while the startup open is still pending lets it land: the mic opens and the reads run', async () => {
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

    // The away window opens and closes again while the open is still in flight.
    harness.shell.setForeground(false)
    harness.shell.setForeground(true)
    resolveOpen(true)
    await starting
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)

    // The loop came up in the foreground: the open is adopted, not closed, and the reads poll.
    expect(harness.deps.closeMic).not.toHaveBeenCalled()
    expect(vi.mocked(harness.deps.readSpeech).mock.calls.length).toBeGreaterThan(0)
  })

  it('a second leave while the restore open is pending closes that late open and keeps the loop away', async () => {
    let resolveReopen: (opened: boolean) => void = () => {}
    const openMic = vi
      .fn(async () => true)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveReopen = resolve
          })
      )
    const harness = createHarness({ openMic })
    await harness.shell.start()
    harness.shell.setForeground(false)
    const readsAtPause = vi.mocked(harness.deps.readSpeech).mock.calls.length

    harness.shell.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(openMic).toHaveBeenCalledTimes(2)
    // The rapid leave cannot close a microphone that has not reopened yet.
    harness.shell.setForeground(false)
    resolveReopen(true)
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS * 5)
    // The late open belongs to the away window: closed, never adopted, and nothing polls.
    expect(harness.deps.closeMic).toHaveBeenCalledTimes(2)
    expect(vi.mocked(harness.deps.readSpeech).mock.calls.length).toBe(readsAtPause)

    // The next return reopens in order; the raced window cost the loop nothing but time.
    harness.shell.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(openMic).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(vi.mocked(harness.deps.readSpeech).mock.calls.length).toBeGreaterThan(readsAtPause)
  })
})

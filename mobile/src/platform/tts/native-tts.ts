import {
  ON_DEVICE_TTS_FAILURES,
  type OnDeviceTts,
  type OnDeviceTtsFailure,
  type OnDeviceTtsPlayback,
  type OnDeviceTtsResult,
  type OnDeviceTtsUtterance
} from './on-device-tts-contract'

// The shell side of the phone's text-to-speech. The engine itself lives in the native audio module; this owns
// the seam's interruption contract — a new utterance stops the playing one, stop silences everything — and
// settles each speak with how its utterance ended.

export type NativeTtsEngine = {
  // Plays the text as the utteranceId utterance, resolving once the engine took it or refused it.
  readonly speak: (
    utteranceId: string,
    text: string,
    locale: string | null
  ) => Promise<{ started: boolean; reason: string | null }>
  // Synchronous and never throws. Ignored with nothing playing.
  readonly stop: () => void
  readonly onDone: (handler: (utteranceId: string) => void) => void
  readonly onError: (handler: (utteranceId: string, code: string) => void) => void
}

export type NativeTtsServer = OnDeviceTts & {
  readonly dispose: () => void
}

// One settle per utterance, keyed by the id the engine's events carry.
type Utterance = {
  readonly id: string
  readonly settle: (result: OnDeviceTtsResult) => void
}

// The speaker is one per phone, so the live utterance is per engine; a server started later interrupts
// an earlier one's playback rather than queueing behind it.
type EngineState = {
  live: Utterance | null
  // Rises once per utterance, so a late event from a dead one cannot match a live id.
  next: number
}

const engineStates = new WeakMap<NativeTtsEngine, EngineState>()

// A newer engine's code the caller does not know still means a plain failure.
function failureOf(code: string): OnDeviceTtsFailure {
  return ON_DEVICE_TTS_FAILURES.find((known) => known === code) ?? 'failed'
}

function endLive(state: EngineState, utteranceId: string, result: OnDeviceTtsResult): void {
  const live = state.live
  // An event for anything but the live utterance is a stopped or superseded one's last words.
  if (live === null || live.id !== utteranceId) {
    return
  }
  state.live = null
  live.settle(result)
}

function engineState(engine: NativeTtsEngine): EngineState {
  const known = engineStates.get(engine)
  if (known !== undefined) {
    return known
  }
  const state: EngineState = { live: null, next: 0 }
  engineStates.set(engine, state)
  // Subscribed once per engine for the app's life, so no utterance can miss or double an event.
  engine.onDone((utteranceId) => endLive(state, utteranceId, { status: 'done' }))
  engine.onError((utteranceId, code) =>
    endLive(state, utteranceId, { status: 'failed', reason: failureOf(code) })
  )
  return state
}

export function createNativeTtsServer(engine: NativeTtsEngine): NativeTtsServer {
  const shared = engineState(engine)

  // Silences the phone whoever is speaking; the live utterance settles with what ended it.
  function stop(reason: 'stopped' | 'interrupted'): void {
    const live = shared.live
    shared.live = null
    live?.settle({ status: reason })
    engine.stop()
  }

  function speak(utterance: OnDeviceTtsUtterance): Promise<OnDeviceTtsResult> {
    // A new utterance interrupts the playing one, whoever started it.
    stop('interrupted')
    let settle!: (result: OnDeviceTtsResult) => void
    const playback = new Promise<OnDeviceTtsResult>((resolve) => {
      settle = resolve
    })
    // Claimed before the engine call, so a stop or a newer speak while it resolves is seen; the id keeps the
    // engine's events on the utterance they belong to.
    const claim: Utterance = { id: `tts-${shared.next++}`, settle }
    shared.live = claim
    void (async () => {
      const started = await engine
        .speak(claim.id, utterance.text, utterance.locale)
        .catch(() => ({ started: false, reason: 'failed' }))
      if (!started.started) {
        if (shared.live === claim) {
          shared.live = null
        }
        settle({ status: 'failed', reason: failureOf(started.reason ?? 'failed') })
        return
      }
      // Armed after this claim was stopped or displaced: silence it, unless a newer utterance took the speaker.
      if (shared.live !== claim && shared.live === null) {
        engine.stop()
      }
    })()
    return playback
  }

  return {
    speak,
    stop: () => stop('stopped'),
    state: (): OnDeviceTtsPlayback =>
      shared.live === null ? { status: 'idle' } : { status: 'speaking' },
    dispose: () => stop('stopped')
  }
}

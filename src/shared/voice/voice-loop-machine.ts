import { condenseReplyForReadout } from './fallback-prose-extractor'

/**
 * The voice-mode loop as a pure routing table. Three active routes — listening, thinking,
 * speaking — framed by idle before the session starts and the terminal closed after a
 * close-tab exit. Speech during speaking is a barge-in: playback stops and the loop
 * re-enters listening, but speech inside the AEC-tail window after any playback stop is
 * echo, not the user, and is refused. Speech while the loop's own turn runs is steering:
 * held across pauses shorter than the silence window, then injected into the running turn
 * when the window closes or a tap flushes it — and dropped if the reply lands first. Time
 * comes only from the injected clock; later platform tickets bind this machine and never
 * extend its table.
 */
export type VoiceLoopRoute = 'idle' | 'listening' | 'thinking' | 'speaking' | 'closed'

export type VoiceLoopVisibility = 'foreground' | 'background'

export type VoiceLoopState = {
  route: VoiceLoopRoute
  visibility: VoiceLoopVisibility
  /** Speech chunks kept across pauses shorter than the silence window, merged at send time. */
  buffer: string[]
  /** Mid-turn speech kept while the loop's own turn runs, merged at steer time. */
  steering: string[]
  /** When the last accepted speech happened; the silence window counts from it. */
  lastSpeechAt: number | null
  /** Speech strictly before this time is echo of stopped playback, never the user. */
  echoUntil: number | null
}

export type VoiceLoopThresholds = {
  /** Quiet time after the last speech before the buffered utterance auto-sends. */
  silenceWindowMs: number
  /** Time after playback stops in which mic input counts as echo, not barge-in. */
  aecTailMs: number
}

export const defaultVoiceLoopThresholds: VoiceLoopThresholds = {
  silenceWindowMs: 1200,
  aecTailMs: 300
}

export type VoiceLoopEvent =
  | { type: 'start'; micExclusiveInUse?: boolean }
  | { type: 'speech'; text: string }
  | { type: 'silence' }
  | { type: 'send' }
  | { type: 'reply'; text: string }
  | { type: 'playbackEnd' }
  | { type: 'visibility'; foreground: boolean }
  | { type: 'closeTab' }

export type VoiceLoopEffect =
  | { kind: 'send'; text: string }
  | { kind: 'steer'; text: string }
  | { kind: 'speak'; text: string }
  | { kind: 'stopPlayback' }

export type VoiceLoopRefusal =
  | 'mic-exclusive'
  | 'already-started'
  | 'closed'
  | 'echo'
  | 'empty-send'
  | 'unexpected-event'

export type VoiceLoopOutcome = {
  state: VoiceLoopState
  effects: VoiceLoopEffect[]
  accepted: boolean
  refusal?: VoiceLoopRefusal
}

export type VoiceLoopDeps = {
  now: () => number
  thresholds?: Partial<VoiceLoopThresholds>
}

export function initialVoiceLoopState(): VoiceLoopState {
  return {
    route: 'idle',
    visibility: 'foreground',
    buffer: [],
    steering: [],
    lastSpeechAt: null,
    echoUntil: null
  }
}

export function voiceLoopTransition(
  state: VoiceLoopState,
  event: VoiceLoopEvent,
  deps: VoiceLoopDeps
): VoiceLoopOutcome {
  if (state.route === 'closed') {
    return refused(state, 'closed')
  }
  const thresholds = { ...defaultVoiceLoopThresholds, ...deps.thresholds }
  const at = deps.now()
  switch (event.type) {
    case 'start': {
      if (state.route !== 'idle') {
        return refused(state, 'already-started')
      }
      if (event.micExclusiveInUse) {
        // An active exclusive mic session ends the request now; it is never queued.
        return refused(state, 'mic-exclusive')
      }
      return moved({ ...state, route: 'listening' })
    }
    case 'closeTab':
      return moved({ ...state, route: 'closed' })
    case 'visibility':
      if (state.route === 'speaking' && !event.foreground) {
        return stopped({ ...state, route: 'listening', visibility: 'background' }, at, thresholds)
      }
      return moved({ ...state, visibility: event.foreground ? 'foreground' : 'background' })
    case 'speech': {
      if (state.echoUntil !== null && at < state.echoUntil) {
        return refused(state, 'echo')
      }
      if (state.route === 'thinking') {
        // The loop's own turn is running; the words steer it once the window closes.
        return moved({
          ...state,
          steering: [...state.steering, event.text.trim()],
          lastSpeechAt: at
        })
      }
      const buffered = { ...state, buffer: [...state.buffer, event.text.trim()], lastSpeechAt: at }
      if (state.route === 'speaking') {
        return stopped({ ...buffered, route: 'listening' }, at, thresholds)
      }
      if (state.route !== 'listening') {
        return refused(state, 'unexpected-event')
      }
      return moved(buffered)
    }
    case 'silence': {
      if (state.route === 'thinking') {
        if (!state.steering.length) {
          return refused(state, 'unexpected-event')
        }
        if (state.lastSpeechAt === null || at < state.lastSpeechAt + thresholds.silenceWindowMs) {
          return moved(state)
        }
        return steerBuffered(state)
      }
      if (state.route !== 'listening') {
        return refused(state, 'unexpected-event')
      }
      if (!state.buffer.length) {
        return moved(state)
      }
      if (state.lastSpeechAt === null || at < state.lastSpeechAt + thresholds.silenceWindowMs) {
        return moved(state)
      }
      return sendBuffered(state)
    }
    case 'send': {
      if (state.route === 'thinking') {
        if (!state.steering.length) {
          return refused(state, 'empty-send')
        }
        return steerBuffered(state)
      }
      if (state.route !== 'listening') {
        return refused(state, 'unexpected-event')
      }
      if (!state.buffer.length) {
        return refused(state, 'empty-send')
      }
      return sendBuffered(state)
    }
    case 'reply': {
      if (state.route !== 'thinking') {
        return refused(state, 'unexpected-event')
      }
      // Late steering cannot catch this turn; the held words are dropped, not steered.
      return moved(
        { ...state, route: 'speaking', echoUntil: null, steering: [], lastSpeechAt: null },
        [{ kind: 'speak', text: condenseReplyForReadout(event.text) }]
      )
    }
    case 'playbackEnd': {
      if (state.route !== 'speaking') {
        return refused(state, 'unexpected-event')
      }
      // Playback is already over; only the echo gate remains.
      return moved({ ...state, route: 'listening', echoUntil: at + thresholds.aecTailMs })
    }
  }
}

function sendBuffered(state: VoiceLoopState): VoiceLoopOutcome {
  return moved({ ...state, route: 'thinking', buffer: [], lastSpeechAt: null }, [
    { kind: 'send', text: state.buffer.filter(Boolean).join(' ') }
  ])
}

/** Steers the running turn with the held words; the loop stays in thinking. */
function steerBuffered(state: VoiceLoopState): VoiceLoopOutcome {
  return moved({ ...state, steering: [], lastSpeechAt: null }, [
    { kind: 'steer', text: state.steering.filter(Boolean).join(' ') }
  ])
}

/** Enters listening from speaking: playback stops and the AEC tail gates what follows. */
function stopped(
  state: VoiceLoopState,
  at: number,
  thresholds: VoiceLoopThresholds
): VoiceLoopOutcome {
  return moved({ ...state, echoUntil: at + thresholds.aecTailMs }, [{ kind: 'stopPlayback' }])
}

function moved(state: VoiceLoopState, effects: VoiceLoopEffect[] = []): VoiceLoopOutcome {
  return { state, effects, accepted: true }
}

function refused(state: VoiceLoopState, refusal: VoiceLoopRefusal): VoiceLoopOutcome {
  return { state, effects: [], accepted: false, refusal }
}

export function createVoiceLoopMachine(deps: VoiceLoopDeps) {
  let state = initialVoiceLoopState()
  return {
    getState(): VoiceLoopState {
      return state
    },
    dispatch(event: VoiceLoopEvent): VoiceLoopOutcome {
      const outcome = voiceLoopTransition(state, event, deps)
      state = outcome.state
      return outcome
    }
  }
}

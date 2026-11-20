import { condenseReplyForReadout } from './fallback-prose-extractor'

/**
 * The voice-mode loop as a pure routing table. Three active routes — listening, thinking,
 * speaking — framed by idle before the session starts and the terminal closed after a
 * close-tab exit. Speech during speaking is a barge-in: playback stops and the loop
 * re-enters listening, but speech inside the AEC-tail window after any playback stop is
 * echo, not the user, and is refused. A reply carries either a model-authored briefing,
 * spoken verbatim, or the reply's own condensed prose; with neither, or with the fallback
 * muted by its setting, there is nothing to say and the loop returns to listening without
 * playback. Time comes only from the injected clock; later platform tickets bind this
 * machine and never extend its table.
 */
export type VoiceLoopRoute = 'idle' | 'listening' | 'thinking' | 'speaking' | 'closed'

export type VoiceLoopVisibility = 'foreground' | 'background'

export type VoiceLoopState = {
  route: VoiceLoopRoute
  visibility: VoiceLoopVisibility
  /** Speech chunks kept across pauses shorter than the silence window, merged at send time. */
  buffer: string[]
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
  | { type: 'reply'; text: string; briefing?: { text: string; lang: string | null } }
  | { type: 'playbackEnd' }
  | { type: 'visibility'; foreground: boolean }
  | { type: 'closeTab' }

export type VoiceLoopEffect =
  | { kind: 'send'; text: string }
  | { kind: 'speak'; text: string; locale?: string }
  | { kind: 'stopPlayback' }

export type VoiceLoopRefusal =
  | 'mic-exclusive'
  | 'already-started'
  | 'closed'
  | 'echo'
  | 'barge-in-disabled'
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
  /** False refuses barge-in: speech during playback never stops it. A tap still can. */
  bargeIn?: boolean
  /** False mutes the reply's fallback prose; an authored briefing still speaks. The loop never stalls either way. */
  fallbackReadout?: boolean
}

export function initialVoiceLoopState(): VoiceLoopState {
  return {
    route: 'idle',
    visibility: 'foreground',
    buffer: [],
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
      if (state.route === 'speaking' && deps.bargeIn === false) {
        // The setting asks for uninterrupted playback; the words spoken over it are dropped, not buffered.
        return refused(state, 'barge-in-disabled')
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
      // A model-authored briefing is spoken verbatim; without one the reply's condensed prose is the readout,
      // unless the fallback setting mutes it.
      const readout =
        event.briefing !== undefined
          ? event.briefing.text
          : deps.fallbackReadout === false
            ? ''
            : condenseReplyForReadout(event.text)
      if (!readout) {
        // Nothing authored and no prose to read: silence, never a stalled loop.
        return moved({ ...state, route: 'listening' })
      }
      return moved({ ...state, route: 'speaking', echoUntil: null }, [
        {
          kind: 'speak',
          text: readout,
          ...(event.briefing !== undefined && event.briefing.lang !== null
            ? { locale: event.briefing.lang }
            : {})
        }
      ])
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

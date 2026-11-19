import { expect, it } from 'vitest'
import {
  createVoiceLoopMachine,
  initialVoiceLoopState,
  voiceLoopTransition,
  type VoiceLoopEvent,
  type VoiceLoopRefusal,
  type VoiceLoopRoute,
  type VoiceLoopState
} from './voice-loop-machine'

const thresholds = { silenceWindowMs: 1000, aecTailMs: 200 }

function machine(now: () => number = () => 0) {
  return createVoiceLoopMachine({ now, thresholds })
}

/** A machine driven to `speaking`, one utterance already sent and one reply playing. */
function speakingMachine() {
  const m = machine()
  m.dispatch({ type: 'start', at: 0 })
  m.dispatch({ type: 'speech', at: 0, text: 'hello there' })
  m.dispatch({ type: 'silence', at: 1000 })
  m.dispatch({ type: 'reply', at: 1100, text: 'One. Two. Three. Four.' })
  return m
}

const routeStates: Record<VoiceLoopRoute, VoiceLoopState> = {
  idle: initialVoiceLoopState(),
  listening: {
    route: 'listening',
    visibility: 'foreground',
    buffer: [],
    lastSpeechAt: null,
    echoUntil: null
  },
  thinking: {
    route: 'thinking',
    visibility: 'foreground',
    buffer: [],
    lastSpeechAt: null,
    echoUntil: null
  },
  speaking: {
    route: 'speaking',
    visibility: 'foreground',
    buffer: [],
    lastSpeechAt: null,
    echoUntil: null
  },
  closed: {
    route: 'closed',
    visibility: 'foreground',
    buffer: [],
    lastSpeechAt: null,
    echoUntil: null
  }
}

const eventsByName: VoiceLoopEvent[] = [
  { type: 'start' },
  { type: 'speech', text: 'hi' },
  { type: 'silence' },
  { type: 'send' },
  { type: 'reply', text: 'hi' },
  { type: 'playbackEnd' },
  { type: 'visibility', foreground: true },
  { type: 'closeTab' }
]

type RouteRow = {
  route: VoiceLoopRoute
  event: VoiceLoopEvent
  nextRoute?: VoiceLoopRoute
  refusal?: VoiceLoopRefusal
  effectKinds?: string[]
}

const routingRows: RouteRow[] = [
  { route: 'idle', event: { type: 'start' }, nextRoute: 'listening' },
  { route: 'idle', event: { type: 'start', micExclusiveInUse: true }, refusal: 'mic-exclusive' },
  { route: 'idle', event: { type: 'speech', text: 'hi' }, refusal: 'unexpected-event' },
  { route: 'idle', event: { type: 'silence' }, refusal: 'unexpected-event' },
  { route: 'idle', event: { type: 'send' }, refusal: 'unexpected-event' },
  { route: 'idle', event: { type: 'reply', text: 'hi' }, refusal: 'unexpected-event' },
  { route: 'idle', event: { type: 'playbackEnd' }, refusal: 'unexpected-event' },
  { route: 'idle', event: { type: 'visibility', foreground: false }, nextRoute: 'idle' },
  { route: 'idle', event: { type: 'closeTab' }, nextRoute: 'closed' },
  { route: 'listening', event: { type: 'start' }, refusal: 'already-started' },
  { route: 'listening', event: { type: 'speech', text: 'hi' }, nextRoute: 'listening' },
  { route: 'listening', event: { type: 'silence' }, nextRoute: 'listening' },
  { route: 'listening', event: { type: 'send' }, refusal: 'empty-send' },
  { route: 'listening', event: { type: 'reply', text: 'hi' }, refusal: 'unexpected-event' },
  { route: 'listening', event: { type: 'playbackEnd' }, refusal: 'unexpected-event' },
  { route: 'listening', event: { type: 'visibility', foreground: true }, nextRoute: 'listening' },
  { route: 'listening', event: { type: 'closeTab' }, nextRoute: 'closed' },
  { route: 'thinking', event: { type: 'start' }, refusal: 'already-started' },
  { route: 'thinking', event: { type: 'speech', text: 'hi' }, refusal: 'unexpected-event' },
  { route: 'thinking', event: { type: 'silence' }, refusal: 'unexpected-event' },
  { route: 'thinking', event: { type: 'send' }, refusal: 'unexpected-event' },
  {
    route: 'thinking',
    event: { type: 'reply', text: 'hi' },
    nextRoute: 'speaking',
    effectKinds: ['speak']
  },
  { route: 'thinking', event: { type: 'playbackEnd' }, refusal: 'unexpected-event' },
  { route: 'thinking', event: { type: 'visibility', foreground: false }, nextRoute: 'thinking' },
  { route: 'thinking', event: { type: 'closeTab' }, nextRoute: 'closed' },
  { route: 'speaking', event: { type: 'start' }, refusal: 'already-started' },
  {
    route: 'speaking',
    event: { type: 'speech', text: 'hi' },
    nextRoute: 'listening',
    effectKinds: ['stopPlayback']
  },
  { route: 'speaking', event: { type: 'silence' }, refusal: 'unexpected-event' },
  { route: 'speaking', event: { type: 'send' }, refusal: 'unexpected-event' },
  { route: 'speaking', event: { type: 'reply', text: 'hi' }, refusal: 'unexpected-event' },
  { route: 'speaking', event: { type: 'playbackEnd' }, nextRoute: 'listening' },
  {
    route: 'speaking',
    event: { type: 'visibility', foreground: false },
    nextRoute: 'listening',
    effectKinds: ['stopPlayback']
  },
  { route: 'speaking', event: { type: 'visibility', foreground: true }, nextRoute: 'speaking' },
  { route: 'speaking', event: { type: 'closeTab' }, nextRoute: 'closed' },
  ...eventsByName.map((event) => ({ route: 'closed' as const, event, refusal: 'closed' as const }))
]

it.each(routingRows)(
  '$route + $event.type',
  ({ route, event, nextRoute, refusal, effectKinds }) => {
    const outcome = voiceLoopTransition(
      routeStates[route],
      { ...event, at: 500 },
      { now: () => 0, thresholds }
    )

    if (refusal) {
      expect(outcome.accepted).toBe(false)
      expect(outcome.refusal).toBe(refusal)
      expect(outcome.effects).toEqual([])
      expect(outcome.state).toEqual(routeStates[route])
    } else {
      expect(outcome.accepted).toBe(true)
      expect(outcome.refusal).toBeUndefined()
      expect(outcome.state.route).toBe(nextRoute)
      expect(outcome.effects.map((effect) => effect.kind)).toEqual(effectKinds ?? [])
    }
  }
)

it('walks the full loop: listen, merge, auto-send, speak condensed, return to listening', () => {
  const m = machine()
  m.dispatch({ type: 'start', at: 0 })
  const heard = m.dispatch({ type: 'speech', at: 0, text: "what's" })
  expect(heard.state.buffer).toEqual(["what's"])
  m.dispatch({ type: 'speech', at: 400, text: 'the time' })
  expect(m.dispatch({ type: 'silence', at: 1399 }).effects).toEqual([])
  const sent = m.dispatch({ type: 'silence', at: 1400 })
  expect(sent.effects).toEqual([{ kind: 'send', text: "what's the time" }])
  expect(sent.state.route).toBe('thinking')
  const spoken = m.dispatch({
    type: 'reply',
    at: 1500,
    text: 'It is noon. Grab an umbrella. Rain is likely. This sentence is cut.'
  })
  expect(spoken.effects).toEqual([
    { kind: 'speak', text: 'It is noon. Grab an umbrella. Rain is likely.' }
  ])
  expect(spoken.state.route).toBe('speaking')
  expect(m.dispatch({ type: 'playbackEnd', at: 4000 }).state.route).toBe('listening')
  m.dispatch({ type: 'speech', at: 4300, text: 'next question' })
  const again = m.dispatch({ type: 'silence', at: 5300 })
  expect(again.effects).toEqual([{ kind: 'send', text: 'next question' }])
})

it('merges speech separated by pauses shorter than the silence window', () => {
  const m = machine()
  m.dispatch({ type: 'start', at: 0 })
  m.dispatch({ type: 'speech', at: 0, text: 'alpha' })
  m.dispatch({ type: 'silence', at: 999 })
  m.dispatch({ type: 'speech', at: 1000, text: 'beta' })
  const sent = m.dispatch({ type: 'silence', at: 2000 })
  expect(sent.effects).toEqual([{ kind: 'send', text: 'alpha beta' }])
})

it('sends on demand and refuses to send an empty buffer', () => {
  const m = machine()
  m.dispatch({ type: 'start', at: 0 })
  expect(m.dispatch({ type: 'send', at: 100 }).refusal).toBe('empty-send')
  m.dispatch({ type: 'speech', at: 100, text: 'go now' })
  const sent = m.dispatch({ type: 'send', at: 200 })
  expect(sent.effects).toEqual([{ kind: 'send', text: 'go now' }])
  expect(sent.state.route).toBe('thinking')
})

it('rejects a start while an exclusive mic session is active instead of queuing it', () => {
  const m = machine()
  const refused = m.dispatch({ type: 'start', at: 0, micExclusiveInUse: true })
  expect(refused.accepted).toBe(false)
  expect(refused.refusal).toBe('mic-exclusive')
  expect(refused.effects).toEqual([])
  expect(refused.state.route).toBe('idle')
  expect(m.dispatch({ type: 'speech', at: 1, text: 'hi' }).refusal).toBe('unexpected-event')
  expect(m.dispatch({ type: 'start', at: 2 }).state.route).toBe('listening')
})

it('barges in on speech during playback and drops echo inside the AEC-tail window', () => {
  const m = speakingMachine()
  const barged = m.dispatch({ type: 'speech', at: 1200, text: 'wait' })
  expect(barged.effects).toEqual([{ kind: 'stopPlayback' }])
  expect(barged.state.route).toBe('listening')
  expect(barged.state.buffer).toEqual(['wait'])
  expect(m.dispatch({ type: 'speech', at: 1399, text: 'echo of the readout' }).refusal).toBe('echo')
  expect(m.getState().buffer).toEqual(['wait'])
  expect(m.dispatch({ type: 'speech', at: 1400, text: 'actually' }).accepted).toBe(true)
  const sent = m.dispatch({ type: 'silence', at: 2400 })
  expect(sent.effects).toEqual([{ kind: 'send', text: 'wait actually' }])
})

it('gates speech after a natural playback end the same way', () => {
  const m = speakingMachine()
  expect(m.dispatch({ type: 'playbackEnd', at: 1200 }).state.route).toBe('listening')
  expect(m.dispatch({ type: 'speech', at: 1399, text: 'echo' }).refusal).toBe('echo')
  expect(m.dispatch({ type: 'speech', at: 1400, text: 'follow-up' }).accepted).toBe(true)
})

it('stops playback when backgrounded mid-readout and resumes listening on return', () => {
  const m = speakingMachine()
  const hidden = m.dispatch({ type: 'visibility', at: 1200, foreground: false })
  expect(hidden.effects).toEqual([{ kind: 'stopPlayback' }])
  expect(hidden.state).toMatchObject({ route: 'listening', visibility: 'background' })
  expect(m.dispatch({ type: 'speech', at: 1399, text: 'echo' }).refusal).toBe('echo')
  expect(m.dispatch({ type: 'speech', at: 1400, text: 'still here' }).accepted).toBe(true)
  const back = m.dispatch({ type: 'visibility', at: 1500, foreground: true })
  expect(back.state).toMatchObject({ route: 'listening', visibility: 'foreground' })
  expect(m.dispatch({ type: 'silence', at: 2400 }).effects).toEqual([
    { kind: 'send', text: 'still here' }
  ])
})

it('exits on close-tab mid-readout and refuses everything afterwards', () => {
  const m = speakingMachine()
  const closed = m.dispatch({ type: 'closeTab', at: 1200 })
  expect(closed.state.route).toBe('closed')
  expect(closed.effects).toEqual([])
  expect(m.dispatch({ type: 'speech', at: 1300, text: 'hello' }).refusal).toBe('closed')
  expect(m.dispatch({ type: 'start', at: 1300 }).refusal).toBe('closed')
  expect(m.dispatch({ type: 'reply', at: 1300, text: 'hi' }).refusal).toBe('closed')
})

it('stamps untimestamped events from the injected clock', () => {
  let t = 5_000
  const m = machine(() => t)
  expect(m.dispatch({ type: 'start' }).state.route).toBe('listening')
  m.dispatch({ type: 'speech', text: 'clock driven' })
  t += 999
  expect(m.dispatch({ type: 'silence' }).effects).toEqual([])
  t += 1
  expect(m.dispatch({ type: 'silence' }).effects).toEqual([{ kind: 'send', text: 'clock driven' }])
})

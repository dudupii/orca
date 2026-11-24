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

/** The one time authority in tests: advance it, then dispatch untimestamped events. */
function fakeClock(startAt = 0) {
  let t = startAt
  return {
    now: () => t,
    advanceTo: (ms: number): void => {
      t = ms
    }
  }
}

function machine(clock = fakeClock()) {
  return createVoiceLoopMachine({ now: clock.now, thresholds })
}

/** A machine driven to `thinking`: one utterance sent, the reply not yet arrived. */
function thinkingMachine() {
  const clock = fakeClock()
  const m = machine(clock)
  m.dispatch({ type: 'start' })
  m.dispatch({ type: 'speech', text: 'hello there' })
  clock.advanceTo(1000)
  m.dispatch({ type: 'silence' })
  clock.advanceTo(1100)
  return { m, clock }
}

/** A machine driven to `speaking`, one utterance already sent and one reply playing. */
function speakingMachine() {
  const { m, clock } = thinkingMachine()
  m.dispatch({ type: 'reply', text: 'One. Two. Three. Four.' })
  return { m, clock }
}

/** A machine driven to `thinking`, its own turn running and nothing steered yet. */
function steeredMachine() {
  const clock = fakeClock()
  const m = machine(clock)
  m.dispatch({ type: 'start' })
  m.dispatch({ type: 'speech', text: 'run the tests' })
  clock.advanceTo(1000)
  m.dispatch({ type: 'silence' })
  return { m, clock }
}

const routeStates: Record<VoiceLoopRoute, VoiceLoopState> = {
  idle: initialVoiceLoopState(),
  listening: {
    route: 'listening',
    visibility: 'foreground',
    buffer: [],
    steering: [],
    lastSpeechAt: null,
    echoUntil: null
  },
  thinking: {
    route: 'thinking',
    visibility: 'foreground',
    buffer: [],
    steering: [],
    lastSpeechAt: null,
    echoUntil: null
  },
  speaking: {
    route: 'speaking',
    visibility: 'foreground',
    buffer: [],
    steering: [],
    lastSpeechAt: null,
    echoUntil: null
  },
  closed: {
    route: 'closed',
    visibility: 'foreground',
    buffer: [],
    steering: [],
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
  { route: 'thinking', event: { type: 'speech', text: 'hi' }, nextRoute: 'thinking' },
  { route: 'thinking', event: { type: 'silence' }, refusal: 'unexpected-event' },
  { route: 'thinking', event: { type: 'send' }, refusal: 'empty-send' },
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
    const clock = fakeClock(500)
    const outcome = voiceLoopTransition(routeStates[route], event, {
      now: clock.now,
      thresholds
    })

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
  const clock = fakeClock()
  const m = machine(clock)
  m.dispatch({ type: 'start' })
  const heard = m.dispatch({ type: 'speech', text: "what's" })
  expect(heard.state.buffer).toEqual(["what's"])
  clock.advanceTo(400)
  m.dispatch({ type: 'speech', text: 'the time' })
  clock.advanceTo(1399)
  expect(m.dispatch({ type: 'silence' }).effects).toEqual([])
  clock.advanceTo(1400)
  const sent = m.dispatch({ type: 'silence' })
  expect(sent.effects).toEqual([{ kind: 'send', text: "what's the time" }])
  expect(sent.state.route).toBe('thinking')
  clock.advanceTo(1500)
  const spoken = m.dispatch({
    type: 'reply',
    text: 'It is noon. Grab an umbrella. Rain is likely. This sentence is cut.'
  })
  expect(spoken.effects).toEqual([
    { kind: 'speak', text: 'It is noon. Grab an umbrella. Rain is likely.' }
  ])
  expect(spoken.state.route).toBe('speaking')
  clock.advanceTo(4000)
  expect(m.dispatch({ type: 'playbackEnd' }).state.route).toBe('listening')
  clock.advanceTo(4300)
  m.dispatch({ type: 'speech', text: 'next question' })
  clock.advanceTo(5300)
  const again = m.dispatch({ type: 'silence' })
  expect(again.effects).toEqual([{ kind: 'send', text: 'next question' }])
})

it('merges speech separated by pauses shorter than the silence window', () => {
  const clock = fakeClock()
  const m = machine(clock)
  m.dispatch({ type: 'start' })
  m.dispatch({ type: 'speech', text: 'alpha' })
  clock.advanceTo(999)
  m.dispatch({ type: 'silence' })
  clock.advanceTo(1000)
  m.dispatch({ type: 'speech', text: 'beta' })
  clock.advanceTo(2000)
  const sent = m.dispatch({ type: 'silence' })
  expect(sent.effects).toEqual([{ kind: 'send', text: 'alpha beta' }])
})

it('sends on demand and refuses to send an empty buffer', () => {
  const clock = fakeClock()
  const m = machine(clock)
  m.dispatch({ type: 'start' })
  clock.advanceTo(100)
  expect(m.dispatch({ type: 'send' }).refusal).toBe('empty-send')
  m.dispatch({ type: 'speech', text: 'go now' })
  clock.advanceTo(200)
  const sent = m.dispatch({ type: 'send' })
  expect(sent.effects).toEqual([{ kind: 'send', text: 'go now' }])
  expect(sent.state.route).toBe('thinking')
})

it('holds mid-turn speech as steering instead of refusing it', () => {
  const { m, clock } = steeredMachine()
  clock.advanceTo(1100)
  const held = m.dispatch({ type: 'speech', text: 'no, the other plan' })
  expect(held.accepted).toBe(true)
  expect(held.state.route).toBe('thinking')
  expect(held.state.steering).toEqual(['no, the other plan'])
  expect(held.state.buffer).toEqual([])
  expect(held.effects).toEqual([])
})

it('refuses mid-turn speech inside the AEC-tail window as echo', () => {
  const clock = fakeClock(500)
  const outcome = voiceLoopTransition(
    { ...routeStates.thinking, echoUntil: 800 },
    { type: 'speech', text: 'too soon' },
    { now: clock.now, thresholds }
  )
  expect(outcome.refusal).toBe('echo')
  expect(outcome.state.steering).toEqual([])
})

it('steers the held words once the silence window closes and stays in thinking', () => {
  const { m, clock } = steeredMachine()
  clock.advanceTo(1100)
  m.dispatch({ type: 'speech', text: 'no,' })
  clock.advanceTo(1200)
  m.dispatch({ type: 'speech', text: 'the other plan' })
  clock.advanceTo(2199)
  expect(m.dispatch({ type: 'silence' }).effects).toEqual([])
  clock.advanceTo(2200)
  const steered = m.dispatch({ type: 'silence' })
  expect(steered.effects).toEqual([{ kind: 'steer', text: 'no, the other plan' }])
  expect(steered.state.steering).toEqual([])
  expect(steered.state.route).toBe('thinking')
})

it('steers immediately on a tap and refuses one with nothing held', () => {
  const { m, clock } = steeredMachine()
  clock.advanceTo(1100)
  m.dispatch({ type: 'speech', text: 'flip it' })
  clock.advanceTo(1150)
  const steered = m.dispatch({ type: 'send' })
  expect(steered.effects).toEqual([{ kind: 'steer', text: 'flip it' }])
  expect(steered.state.steering).toEqual([])
  expect(steered.state.route).toBe('thinking')
  clock.advanceTo(1200)
  expect(m.dispatch({ type: 'send' }).refusal).toBe('empty-send')
})

it('drops steering when the reply lands first, without a steer effect', () => {
  const { m, clock } = steeredMachine()
  clock.advanceTo(1100)
  m.dispatch({ type: 'speech', text: 'too late words' })
  clock.advanceTo(1500)
  const spoken = m.dispatch({ type: 'reply', text: 'Done already.' })
  expect(spoken.effects).toEqual([{ kind: 'speak', text: 'Done already.' }])
  expect(spoken.state.steering).toEqual([])
  expect(spoken.state.route).toBe('speaking')
})

it('treats idle speech as a plain turn start: one send, never a steer', () => {
  const clock = fakeClock()
  const m = machine(clock)
  m.dispatch({ type: 'start' })
  m.dispatch({ type: 'speech', text: 'fresh question' })
  clock.advanceTo(1000)
  const sent = m.dispatch({ type: 'silence' })
  expect(sent.effects).toEqual([{ kind: 'send', text: 'fresh question' }])
  expect(sent.state.route).toBe('thinking')
  expect(sent.state.steering).toEqual([])
})

it('rejects a start while an exclusive mic session is active instead of queuing it', () => {
  const clock = fakeClock()
  const m = machine(clock)
  const refused = m.dispatch({ type: 'start', micExclusiveInUse: true })
  expect(refused.accepted).toBe(false)
  expect(refused.refusal).toBe('mic-exclusive')
  expect(refused.effects).toEqual([])
  expect(refused.state.route).toBe('idle')
  clock.advanceTo(1)
  expect(m.dispatch({ type: 'speech', text: 'hi' }).refusal).toBe('unexpected-event')
  clock.advanceTo(2)
  expect(m.dispatch({ type: 'start' }).state.route).toBe('listening')
})

it('barges in on speech during playback and drops echo inside the AEC-tail window', () => {
  const { m, clock } = speakingMachine()
  clock.advanceTo(1200)
  const barged = m.dispatch({ type: 'speech', text: 'wait' })
  expect(barged.effects).toEqual([{ kind: 'stopPlayback' }])
  expect(barged.state.route).toBe('listening')
  expect(barged.state.buffer).toEqual(['wait'])
  clock.advanceTo(1399)
  expect(m.dispatch({ type: 'speech', text: 'echo of the readout' }).refusal).toBe('echo')
  expect(m.getState().buffer).toEqual(['wait'])
  clock.advanceTo(1400)
  expect(m.dispatch({ type: 'speech', text: 'actually' }).accepted).toBe(true)
  clock.advanceTo(2400)
  const sent = m.dispatch({ type: 'silence' })
  expect(sent.effects).toEqual([{ kind: 'send', text: 'wait actually' }])
})

it('gates speech after a natural playback end the same way', () => {
  const { m, clock } = speakingMachine()
  clock.advanceTo(1200)
  expect(m.dispatch({ type: 'playbackEnd' }).state.route).toBe('listening')
  clock.advanceTo(1399)
  expect(m.dispatch({ type: 'speech', text: 'echo' }).refusal).toBe('echo')
  clock.advanceTo(1400)
  expect(m.dispatch({ type: 'speech', text: 'follow-up' }).accepted).toBe(true)
})

it('stops playback when backgrounded mid-readout and resumes listening on return', () => {
  const { m, clock } = speakingMachine()
  clock.advanceTo(1200)
  const hidden = m.dispatch({ type: 'visibility', foreground: false })
  expect(hidden.effects).toEqual([{ kind: 'stopPlayback' }])
  expect(hidden.state).toMatchObject({ route: 'listening', visibility: 'background' })
  clock.advanceTo(1399)
  expect(m.dispatch({ type: 'speech', text: 'echo' }).refusal).toBe('echo')
  clock.advanceTo(1400)
  expect(m.dispatch({ type: 'speech', text: 'still here' }).accepted).toBe(true)
  clock.advanceTo(1500)
  const back = m.dispatch({ type: 'visibility', foreground: true })
  expect(back.state).toMatchObject({ route: 'listening', visibility: 'foreground' })
  clock.advanceTo(2400)
  expect(m.dispatch({ type: 'silence' }).effects).toEqual([{ kind: 'send', text: 'still here' }])
})

it('exits on close-tab mid-readout and refuses everything afterwards', () => {
  const { m, clock } = speakingMachine()
  clock.advanceTo(1200)
  const closed = m.dispatch({ type: 'closeTab' })
  expect(closed.state.route).toBe('closed')
  expect(closed.effects).toEqual([])
  clock.advanceTo(1300)
  expect(m.dispatch({ type: 'speech', text: 'hello' }).refusal).toBe('closed')
  expect(m.dispatch({ type: 'start' }).refusal).toBe('closed')
  expect(m.dispatch({ type: 'reply', text: 'hi' }).refusal).toBe('closed')
})

it('auto-sends from a clock that starts away from zero', () => {
  const clock = fakeClock(5_000)
  const m = machine(clock)
  expect(m.dispatch({ type: 'start' }).state.route).toBe('listening')
  m.dispatch({ type: 'speech', text: 'clock driven' })
  clock.advanceTo(5_999)
  expect(m.dispatch({ type: 'silence' }).effects).toEqual([])
  clock.advanceTo(6_000)
  expect(m.dispatch({ type: 'silence' }).effects).toEqual([{ kind: 'send', text: 'clock driven' }])
})

it('speaks a model-authored briefing verbatim, its language riding the speak effect', () => {
  const clock = fakeClock()
  const m = machine(clock)
  m.dispatch({ type: 'start' })
  m.dispatch({ type: 'speech', text: 'go on' })
  clock.advanceTo(1000)
  m.dispatch({ type: 'silence' })
  clock.advanceTo(1100)
  const spoken = m.dispatch({
    type: 'reply',
    text: 'One. Two. Three. Four.',
    briefing: { text: 'Done. All checks pass. First. Second. Third. Fourth.', lang: 'zh-CN' }
  })
  expect(spoken.state.route).toBe('speaking')
  // The briefing is never condensed and its lang overrides the phone's own language.
  expect(spoken.effects).toEqual([
    { kind: 'speak', text: 'Done. All checks pass. First. Second. Third. Fourth.', locale: 'zh-CN' }
  ])
})

it('a briefing without a language leaves the locale to the phone', () => {
  const { m } = thinkingMachine()
  const spoken = m.dispatch({
    type: 'reply',
    text: 'ignored',
    briefing: { text: 'Brief words.', lang: null }
  })
  expect(spoken.effects).toEqual([{ kind: 'speak', text: 'Brief words.' }])
})

it('washes a screen-written briefing before it is spoken, its language still riding the effect', () => {
  const { m } = thinkingMachine()
  const spoken = m.dispatch({
    type: 'reply',
    text: 'ignored',
    briefing: {
      text: '**Done**. 清单在 [#50 评论里的清单](https://github.com/dudupii/orca/issues/50#issuecomment-7086648152)。',
      lang: 'zh-CN'
    }
  })
  expect(spoken.effects).toEqual([
    { kind: 'speak', text: 'Done. 清单在 50 号问题 评论里的清单。', locale: 'zh-CN' }
  ])
})

it('washes the condensed fallback too, so markdown never reaches the speak effect', () => {
  const { m } = thinkingMachine()
  const spoken = m.dispatch({
    type: 'reply',
    text: 'It is *noon*. Grab an **umbrella**. Rain is likely. Fourth sentence.'
  })
  expect(spoken.effects).toEqual([
    { kind: 'speak', text: 'It is noon. Grab an umbrella. Rain is likely.' }
  ])
})

it('stays silent when a briefing washes away to nothing', () => {
  const { m } = thinkingMachine()
  const silent = m.dispatch({
    type: 'reply',
    text: 'ignored',
    briefing: { text: 'https://github.com/dudupii/orca/pull/27#issuecomment-1', lang: null }
  })
  expect(silent.effects).toEqual([])
  expect(silent.state.route).toBe('listening')
})

it('returns to listening without playback when there is nothing to read aloud', () => {
  const { m, clock } = thinkingMachine()
  const silent = m.dispatch({ type: 'reply', text: '' })
  expect(silent.accepted).toBe(true)
  expect(silent.effects).toEqual([])
  expect(silent.state.route).toBe('listening')
  // No playback happened, so no echo gate arms: the next words are heard at once.
  expect(m.dispatch({ type: 'speech', text: 'still here' }).accepted).toBe(true)
  clock.advanceTo(2100)
  expect(m.dispatch({ type: 'silence' }).effects).toEqual([{ kind: 'send', text: 'still here' }])
})

it('refuses barge-in speech while the setting is off, leaving playback intact', () => {
  const clock = fakeClock()
  const m = createVoiceLoopMachine({ now: clock.now, thresholds, bargeIn: false })
  m.dispatch({ type: 'start' })
  m.dispatch({ type: 'speech', text: 'hello there' })
  clock.advanceTo(1000)
  m.dispatch({ type: 'silence' })
  clock.advanceTo(1100)
  m.dispatch({ type: 'reply', text: 'One. Two. Three. Four.' })

  clock.advanceTo(1200)
  const overheard = m.dispatch({ type: 'speech', text: 'wait' })
  expect(overheard.accepted).toBe(false)
  expect(overheard.refusal).toBe('barge-in-disabled')
  // Playback was never cut and the words spoken over it are not buffered.
  expect(overheard.state.route).toBe('speaking')
  expect(overheard.state.buffer).toEqual([])

  clock.advanceTo(4000)
  expect(m.dispatch({ type: 'playbackEnd' }).state.route).toBe('listening')
  // The echo gate still arms after the natural end; the buffer stays empty.
  clock.advanceTo(4199)
  expect(m.dispatch({ type: 'speech', text: 'echo' }).refusal).toBe('echo')
  clock.advanceTo(4200)
  const next = m.dispatch({ type: 'speech', text: 'now my turn' })
  expect(next.accepted).toBe(true)
  expect(next.state.buffer).toEqual(['now my turn'])
})

it('mutes the fallback prose while the setting is off, yet an authored briefing still speaks', () => {
  const clock = fakeClock()
  const m = createVoiceLoopMachine({ now: clock.now, thresholds, fallbackReadout: false })
  m.dispatch({ type: 'start' })
  m.dispatch({ type: 'speech', text: 'hello there' })
  clock.advanceTo(1000)
  m.dispatch({ type: 'silence' })
  clock.advanceTo(1100)
  const muted = m.dispatch({ type: 'reply', text: 'One. Two. Three. Four.' })
  expect(muted.state.route).toBe('listening')
  expect(muted.effects).toEqual([])

  clock.advanceTo(2000)
  m.dispatch({ type: 'speech', text: 'again' })
  clock.advanceTo(3000)
  m.dispatch({ type: 'silence' })
  clock.advanceTo(3100)
  const spoken = m.dispatch({
    type: 'reply',
    text: 'ignored',
    briefing: { text: 'Authored words.', lang: null }
  })
  expect(spoken.effects).toEqual([{ kind: 'speak', text: 'Authored words.' }])
})

// The foreground policy against the machine's own table: every route the loop can sit in when the
// app leaves, every way a reply can land around the away window, and the chime each combination
// earns — asserted from voiceLoopTransition's outcomes, never re-imagined here.
import { describe, expect, it } from 'vitest'
import {
  createVoiceLoopMachine,
  type VoiceLoopEvent,
  type VoiceLoopOutcome,
  type VoiceLoopRoute,
  type VoiceLoopVisibility
} from '../../../src/shared/voice/voice-loop-machine'
import { VoiceLoopForeground, type VoiceLoopDeferredSpeak } from './voice-loop-foreground'
import type { OnDeviceToneKind } from '../platform/tone/on-device-tone-contract'

// The machine's own tail windows, read here only to step past them.
const AEC_TAIL_MS = 300

type Rig = {
  /** Advances the machine's clock; the policy keeps no clocks of its own. */
  at: (ms: number) => void
  dispatch: (event: VoiceLoopEvent) => VoiceLoopOutcome
  route: () => VoiceLoopRoute
  visibility: () => VoiceLoopVisibility
  policy: VoiceLoopForeground
  tones: OnDeviceToneKind[]
  /** The app left, exactly as the shell drives it: the machine moves first, the policy reads the route. */
  leave: () => VoiceLoopOutcome
  /** The app came back; returns the playback the policy parked for the restore. */
  comeBack: () => { outcome: VoiceLoopOutcome; deferred: VoiceLoopDeferredSpeak | null }
  /** A reply event the machine accepts, with the policy reading the accept exactly as the shell does. */
  acceptReply: (text: string) => {
    outcome: VoiceLoopOutcome
    speak: VoiceLoopDeferredSpeak | null
    playNow: boolean
  }
}

function createRig(): Rig {
  const tones: OnDeviceToneKind[] = []
  let ms = 0
  const machine = createVoiceLoopMachine({ now: () => ms })
  const policy = new VoiceLoopForeground({
    tone: { play: (kind) => tones.push(kind) }
  })
  const speakOf = (outcome: VoiceLoopOutcome): VoiceLoopDeferredSpeak | null =>
    outcome.effects.find((effect): effect is VoiceLoopDeferredSpeak => effect.kind === 'speak') ??
    null
  return {
    at: (next) => {
      ms = next
    },
    dispatch: (event) => machine.dispatch(event),
    route: () => machine.getState().route,
    visibility: () => machine.getState().visibility,
    policy,
    tones,
    leave: () => {
      const outcome = machine.dispatch({ type: 'visibility', foreground: false })
      policy.background(machine.getState().route)
      return outcome
    },
    comeBack: () => {
      const outcome = machine.dispatch({ type: 'visibility', foreground: true })
      // The shell resumes only a loop it paused; the parked playback is its answer.
      const deferred = policy.isBackgrounded() ? policy.restore() : null
      return { outcome, deferred }
    },
    acceptReply: (text) => {
      const outcome = machine.dispatch({ type: 'reply', text })
      const speak = speakOf(outcome)
      const playNow = policy.replyAccepted(machine.getState().visibility, speak)
      return { outcome, speak, playNow }
    }
  }
}

// The routes the matrix backgrounds from, each reached through the table's own events.
function atListening(rig: Rig, buffered = true): void {
  rig.dispatch({ type: 'start' })
  if (buffered) {
    rig.dispatch({ type: 'speech', text: 'hello' })
  }
}

function atThinking(rig: Rig): void {
  atListening(rig)
  rig.dispatch({ type: 'send' })
}

function atSpeaking(rig: Rig): void {
  atThinking(rig)
  rig.acceptReply('First answer.')
}

describe('VoiceLoopForeground', () => {
  describe('the route at background × where the reply lands', () => {
    it('listening, reply during the away: parks it, chimes once at the restore', () => {
      const rig = createRig()
      atListening(rig)
      rig.leave()
      // The pending commit fires while away: its turn runs and answers in the background.
      rig.dispatch({ type: 'send' })
      const accepted = rig.acceptReply('Done while away.')
      expect(accepted.outcome.accepted).toBe(true)
      expect(accepted.playNow).toBe(false)
      expect(rig.tones).toEqual([])

      const back = rig.comeBack()
      expect(rig.tones).toEqual(['restore'])
      // The parked playback is the machine's own speak effect for that reply, and the machine
      // held speaking for it through the away and the return alike.
      expect(back.deferred).toEqual(accepted.speak)
      expect(rig.route()).toBe('speaking')
      expect(rig.visibility()).toBe('foreground')
    })

    it('listening, reply after the restore: plays now, no chime for a turn that never straddled', () => {
      const rig = createRig()
      atListening(rig)
      rig.leave()
      const back = rig.comeBack()
      expect(rig.tones).toEqual([])
      expect(back.deferred).toBeNull()

      rig.dispatch({ type: 'send' })
      const accepted = rig.acceptReply('Done after the return.')
      expect(accepted.playNow).toBe(true)
      expect(rig.tones).toEqual([])
    })

    it('listening with only buffered words: the restore is silent', () => {
      const rig = createRig()
      atListening(rig)
      rig.leave()
      const back = rig.comeBack()
      expect(rig.tones).toEqual([])
      expect(back.deferred).toBeNull()
      expect(rig.route()).toBe('listening')
    })

    it('thinking, reply during the away: parks it, chimes once at the restore', () => {
      const rig = createRig()
      atThinking(rig)
      rig.leave()
      const accepted = rig.acceptReply('Done while away.')
      expect(accepted.playNow).toBe(false)
      expect(rig.tones).toEqual([])

      const back = rig.comeBack()
      expect(rig.tones).toEqual(['restore'])
      expect(back.deferred).toEqual(accepted.speak)
    })

    it('thinking, reply after the restore: the straddled turn chimes as it answers', () => {
      const rig = createRig()
      atThinking(rig)
      rig.leave()
      // The turn was still running at the return, so the restore itself stays silent.
      const back = rig.comeBack()
      expect(rig.tones).toEqual([])
      expect(back.deferred).toBeNull()

      const accepted = rig.acceptReply('The answer that outlasted the away.')
      expect(accepted.playNow).toBe(true)
      expect(rig.tones).toEqual(['restore'])
    })

    it('thinking, reply never: the restore is silent while the turn runs on', () => {
      const rig = createRig()
      atThinking(rig)
      rig.leave()
      const back = rig.comeBack()
      expect(rig.tones).toEqual([])
      expect(back.deferred).toBeNull()
    })

    it('speaking, reply during the away: the cut playback ends the turn before the new one parks', () => {
      const rig = createRig()
      atSpeaking(rig)
      const left = rig.leave()
      // The table stops a speaking loop outright on background: its outcome is the oracle.
      expect(left.accepted).toBe(true)
      expect(left.effects).toEqual([{ kind: 'stopPlayback' }])
      expect(rig.route()).toBe('listening')
      expect(rig.visibility()).toBe('background')

      // Past the machine's echo tail, a fresh turn runs and answers while away.
      rig.at(AEC_TAIL_MS + 100)
      rig.dispatch({ type: 'speech', text: 'more' })
      rig.dispatch({ type: 'send' })
      const accepted = rig.acceptReply('Done while away.')
      expect(accepted.playNow).toBe(false)

      const back = rig.comeBack()
      expect(rig.tones).toEqual(['restore'])
      expect(back.deferred).toEqual(accepted.speak)
    })

    it('speaking, reply after the restore: plays now with no chime', () => {
      const rig = createRig()
      atSpeaking(rig)
      rig.leave()
      const back = rig.comeBack()
      expect(rig.tones).toEqual([])
      expect(back.deferred).toBeNull()

      rig.at(AEC_TAIL_MS + 100)
      rig.dispatch({ type: 'speech', text: 'more' })
      rig.dispatch({ type: 'send' })
      const accepted = rig.acceptReply('Done after the return.')
      expect(accepted.playNow).toBe(true)
      expect(rig.tones).toEqual([])
    })

    it('speaking, reply never: the restore returns the loop to listening, silently', () => {
      const rig = createRig()
      atSpeaking(rig)
      rig.leave()
      const back = rig.comeBack()
      expect(rig.tones).toEqual([])
      expect(back.deferred).toBeNull()
      expect(back.outcome.state.route).toBe('listening')
    })
  })

  it('chimes exactly once for an away window however many replies land in it', () => {
    const rig = createRig()
    atThinking(rig)
    rig.leave()
    // A reply with nothing to say ends its turn without playback; a second one follows in the same window.
    const quiet = rig.acceptReply('')
    expect(quiet.outcome.accepted).toBe(true)
    expect(quiet.speak).toBeNull()
    rig.at(AEC_TAIL_MS + 100)
    rig.dispatch({ type: 'speech', text: 'again' })
    rig.dispatch({ type: 'send' })
    const spoken = rig.acceptReply('The second answer.')
    expect(spoken.playNow).toBe(false)

    const back = rig.comeBack()
    expect(rig.tones).toEqual(['restore'])
    expect(back.deferred).toEqual(spoken.speak)
  })

  it('keeps a parked reply earning its chime through a second leave before the return', () => {
    const rig = createRig()
    atThinking(rig)
    rig.leave()
    const accepted = rig.acceptReply('Done while away.')
    // The platform fires another non-active change (inactive after background) before the return.
    rig.leave()
    const back = rig.comeBack()
    expect(rig.tones).toEqual(['restore'])
    expect(back.deferred).toEqual(accepted.speak)
  })

  it('chimes for a straddled turn only once, never for the turns after it', () => {
    const rig = createRig()
    atThinking(rig)
    rig.leave()
    rig.comeBack()
    const straddled = rig.acceptReply('The straddled answer.')
    expect(straddled.playNow).toBe(true)
    expect(rig.tones).toEqual(['restore'])

    // The playback ends and a wholly-foreground turn answers: no second chime.
    rig.dispatch({ type: 'playbackEnd' })
    rig.dispatch({ type: 'speech', text: 'next' })
    rig.dispatch({ type: 'send' })
    const fresh = rig.acceptReply('A turn begun in the foreground.')
    expect(fresh.playNow).toBe(true)
    expect(rig.tones).toEqual(['restore'])
  })

  it('a second return with no leave between it and the first reopens nothing again', () => {
    const rig = createRig()
    atListening(rig, false)
    rig.leave()
    rig.comeBack()
    // A duplicate active change reaches a policy already restored: no chime, no parked playback.
    const back = rig.comeBack()
    expect(rig.tones).toEqual([])
    expect(back.deferred).toBeNull()
  })

  it('reset drops everything a loop parked, earned or straddled', () => {
    const rig = createRig()
    atThinking(rig)
    rig.leave()
    rig.acceptReply('Done while away.')
    rig.policy.reset()
    expect(rig.policy.isBackgrounded()).toBe(false)
    const back = rig.comeBack()
    expect(rig.tones).toEqual([])
    expect(back.deferred).toBeNull()
  })
})

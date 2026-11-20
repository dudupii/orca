import {
  createVoiceLoopMachine,
  defaultVoiceLoopThresholds,
  type VoiceLoopEffect,
  type VoiceLoopThresholds
} from '../../../src/shared/voice/voice-loop-machine'
import { VoiceLoopTranscriptLedger, spokenText } from './voice-loop-transcript-ledger'
import { VoiceLoopForeground, type VoiceLoopDeferredSpeak } from './voice-loop-foreground'
import { VoiceLoopPlatformSession } from './voice-loop-platform-session'
import type {
  VoiceLoopShellDeps,
  VoiceLoopTranscriptRead,
  VoiceLoopView
} from './voice-loop-shell-contract'

// Same pace the dictation drain reads at; the bridge has no push lane for transcripts.
const DEFAULT_READ_INTERVAL_MS = 150

/** The first effect of a kind, if the transition emitted one; the machine never emits doubles. */
function effectOf<K extends VoiceLoopEffect['kind']>(
  effects: readonly VoiceLoopEffect[],
  kind: K
): Extract<VoiceLoopEffect, { kind: K }> | null {
  return (
    effects.find(
      (effect): effect is Extract<VoiceLoopEffect, { kind: K }> => effect.kind === kind
    ) ?? null
  )
}

/**
 * Binds T1's voice-loop machine to the phone's seams. The machine owns every route and buffer
 * decision; this shell owns only what the machine's table does not model: when to poll, the
 * response-delay window that makes a finalized utterance — or held steering — revocable,
 * playback (the machine's speak effect plays through the readout and playbackEnd arrives when
 * it settles), and platform release order. The delay window arms after the machine's own
 * silence window has passed with the words held, so the commit still happens through the
 * machine's own event, sending the buffer in listening or steering the running turn in thinking.
 * While no chat seam is bound (chatBound false) the commit stage holds its fire — the wait
 * never arms and the words stay held in the machine until a seam binds again.
 */
export class VoiceLoopShell {
  private readonly thresholds: VoiceLoopThresholds
  private readonly readIntervalMs: number
  private readonly machine: ReturnType<typeof createVoiceLoopMachine>
  private readonly foreground: VoiceLoopForeground
  private readonly platform: VoiceLoopPlatformSession
  private view: VoiceLoopView = { route: 'idle', transcript: '', pending: null, reply: null }
  private generation = 0
  private readTimer: ReturnType<typeof setTimeout> | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private readonly ledger = new VoiceLoopTranscriptLedger()
  private suppressPending = false
  private starting = false
  private started = false
  private exited = false

  constructor(private readonly deps: VoiceLoopShellDeps) {
    this.thresholds = { ...defaultVoiceLoopThresholds, ...deps.thresholds }
    this.readIntervalMs = deps.readIntervalMs ?? DEFAULT_READ_INTERVAL_MS
    this.foreground = new VoiceLoopForeground({ tone: deps.tone ?? null })
    this.platform = new VoiceLoopPlatformSession(deps)
    this.machine = createVoiceLoopMachine({
      now: deps.now,
      thresholds: this.thresholds,
      bargeIn: deps.bargeIn,
      fallbackReadout: deps.fallbackReadout
    })
  }

  currentView(): VoiceLoopView {
    return this.view
  }

  async start(): Promise<void> {
    // A closed machine is terminal and a spent shell stays spent; the entry makes a fresh shell.
    if (
      this.starting ||
      this.started ||
      this.exited ||
      this.machine.getState().route === 'closed'
    ) {
      return
    }
    this.starting = true
    try {
      await this.startPlatform()
    } catch {
      // A seam that throws mid-startup leaves nothing usable: report it, unwind, stay retryable.
      if (!this.exited) {
        this.starting = false
        this.deps.onNotice('mic-unavailable')
        this.platform.release()
        this.settleClosed()
      }
    }
  }

  private async startPlatform(): Promise<void> {
    const armed = await this.deps.startSpeech()
    if (this.exited) {
      if (armed.started) {
        this.deps.cancelSpeech()
      }
      return
    }
    if (!armed.started) {
      this.starting = false
      if (armed.busy) {
        // The refusal is the machine's to make; the shell only makes it visible.
        this.machine.dispatch({ type: 'start', micExclusiveInUse: true })
        this.deps.onNotice('mic-exclusive')
      } else {
        this.deps.onNotice('mic-unavailable')
      }
      this.settleClosed()
      return
    }
    this.platform.markSpeechArmed()
    this.platform.holdScreen()
    if (this.foreground.isBackgrounded()) {
      // The app left while the recognizer was arming: the loop comes up already paused, its
      // microphone and reads waiting for the return.
      this.beginLoop()
      return
    }
    const micOpen = await this.deps.openMic()
    if (this.exited) {
      // The exit before the open could not release what had not opened; the late open is ours.
      if (micOpen) {
        this.platform.markMicOpened()
      }
      this.platform.release()
      return
    }
    if (!micOpen) {
      this.starting = false
      this.deps.onNotice('mic-unavailable')
      this.platform.release()
      this.settleClosed()
      return
    }
    if (this.foreground.isBackgrounded()) {
      // A leave won the race with the open: the capture it started must not run away with the app.
      this.deps.closeMic()
      this.beginLoop()
      return
    }
    this.platform.markMicOpened()
    this.beginLoop()
    this.scheduleRead()
  }

  /** Marks the loop up: started, the machine's start accepted, the first view published. */
  private beginLoop(): void {
    this.starting = false
    this.started = true
    this.machine.dispatch({ type: 'start' })
    this.publish()
  }

  /** A tap on the waiting utterance cancels its send; a waiting steer is handed to the turn now. */
  tapPending(): void {
    if (this.view.pending === null) {
      return
    }
    this.clearPendingTimer()
    this.view = { ...this.view, pending: null }
    if (this.machine.getState().route === 'thinking') {
      // The turn is running; an eager tap steers it now rather than waiting out the delay.
      void this.commit('send')
      return
    }
    // Quiet alone must not re-arm the wait; only new speech does.
    this.suppressPending = true
    this.publish()
  }

  /** A tap on the readout stops it; the loop returns to listening through the machine's echo gate. */
  stopSpeaking(): void {
    if (this.machine.getState().route !== 'speaking') {
      return
    }
    this.deps.readout.stop()
  }

  /**
   * The app left or came back. The machine's visibility moves first — its table stops a speaking
   * loop outright — and the loop's platforms follow the foreground policy: away closes the
   * microphone and suspends the reads; the restore sounds its chime, plays what waited and only
   * then reopens the microphone. The policy tracks the app even before the loop is up, so a
   * startup racing a leave reconciles with the window that leave opened.
   */
  setForeground(foreground: boolean): void {
    if (this.exited) {
      return
    }
    if (foreground || this.machine.getState().visibility !== 'background') {
      const outcome = this.machine.dispatch({ type: 'visibility', foreground })
      if (effectOf(outcome.effects, 'stopPlayback') !== null) {
        // Speaking into background: the machine cut the playback; its play settles stopped on its own.
        this.deps.readout.stop()
      }
      this.publish()
    }
    if (!foreground) {
      // The window opens with the leave itself, started loop or not: a startup racing it reconciles.
      this.foreground.background(this.machine.getState().route)
    }
    if (!this.started) {
      // Nothing platform-side is open yet; a return while the startup runs just closes the window.
      if (foreground) {
        this.foreground.restore()
      }
      return
    }
    if (foreground) {
      void this.resume()
      return
    }
    this.pause()
  }

  private pause(): void {
    if (this.readTimer !== null) {
      clearTimeout(this.readTimer)
      this.readTimer = null
    }
    // Idempotent over the native listener that already ended capture on the activity's pause.
    this.platform.closeMic()
  }

  private async resume(): Promise<void> {
    if (this.exited || !this.started || !this.foreground.isBackgrounded()) {
      return
    }
    // The chime first, the parked playback next; the microphone reopens only after both.
    const deferred = this.foreground.restore()
    if (deferred !== null) {
      void this.playDeferred(deferred)
    }
    const opened = await this.deps.openMic()
    if (this.exited || this.foreground.isBackgrounded()) {
      // The exit could not close, and a second leave cannot adopt, a microphone that had not
      // reopened yet; the late open is ours to close, and the next return opens its own.
      if (opened) {
        this.deps.closeMic()
      }
      return
    }
    if (!opened) {
      // The refused reopen ends the loop as a refused start does: spent, never resurrected
      // by a later leave and return.
      this.deps.onNotice('mic-unavailable')
      this.exit()
      return
    }
    this.platform.markMicOpened()
    this.scheduleRead()
  }

  /** Plays the reply a background window parked; the machine held speaking for it through the away. */
  private async playDeferred(speak: VoiceLoopDeferredSpeak): Promise<void> {
    const generation = this.generation
    await this.deps.readout.play({ text: speak.text, locale: speak.locale ?? null })
    if (this.exited || generation !== this.generation) {
      return
    }
    if (this.machine.getState().route === 'speaking') {
      this.machine.dispatch({ type: 'playbackEnd' })
      this.publish()
    }
  }

  /** Ends the loop: the machine settles terminal, then the recognizer, mic and screen release. */
  exit(): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.starting = false
    this.started = false
    this.generation += 1
    this.foreground.reset()
    if (this.readTimer !== null) {
      clearTimeout(this.readTimer)
      this.readTimer = null
    }
    this.clearPendingTimer()
    if (this.machine.getState().route !== 'closed') {
      this.machine.dispatch({ type: 'closeTab' })
    }
    this.platform.release()
    this.publish()
  }

  dispose(): void {
    this.exit()
  }

  /** Ends a loop that never began, through the machine's own close, so its holder can drop it. */
  private settleClosed(): void {
    if (this.machine.getState().route !== 'closed') {
      this.machine.dispatch({ type: 'closeTab' })
    }
    this.publish()
  }

  private scheduleRead(): void {
    if (this.exited || this.readTimer !== null || this.foreground.isBackgrounded()) {
      return
    }
    this.readTimer = setTimeout(() => {
      this.readTimer = null
      void this.tick()
    }, this.readIntervalMs)
  }

  private async tick(): Promise<void> {
    if (this.exited) {
      return
    }
    const generation = this.generation
    let read: VoiceLoopTranscriptRead
    try {
      read = await this.deps.readSpeech()
    } catch {
      read = { revision: 0, committed: '', tentative: '', failure: 'failed' }
    }
    if (this.exited || generation !== this.generation) {
      return
    }
    if (read.failure !== null) {
      this.deps.onNotice('speech-failed')
      this.exit()
      return
    }
    if (this.ingest(read)) {
      this.publish()
    }
    this.armPendingIfQuiet()
    this.scheduleRead()
  }

  /** Records one new transcript revision; returns whether the drawn words changed. */
  private ingest(read: VoiceLoopTranscriptRead): boolean {
    const heard = this.ledger.ingest(read, this.deps.now())
    if (heard.delta !== null) {
      const outcome = this.machine.dispatch({ type: 'speech', text: heard.delta })
      if (effectOf(outcome.effects, 'stopPlayback') !== null) {
        // Barge-in: the machine cut the playback; the speaker goes silent and its play settles stopped.
        this.deps.readout.stop()
      }
    }
    if (heard.spoke) {
      // Speech during the wait un-finalizes the utterance: the buffer keeps growing.
      if (this.view.pending !== null) {
        this.clearPendingTimer()
        this.view = { ...this.view, pending: null }
      }
      this.suppressPending = false
    }
    return heard.spoke
  }

  private armPendingIfQuiet(): void {
    if (this.view.pending !== null || this.suppressPending) {
      return
    }
    // No chat seam is bound: the wait stays un-armed, its words held in the machine for the rebind.
    if (this.deps.chatBound?.() === false) {
      return
    }
    const state = this.machine.getState()
    // The wait arms for either commit: the running turn's steer or the next send's buffer.
    const held =
      state.route === 'thinking' ? state.steering : state.route === 'listening' ? state.buffer : []
    const activityAt = this.ledger.activityAt()
    if (held.length === 0 || activityAt === null) {
      return
    }
    if (this.deps.now() - activityAt < this.thresholds.silenceWindowMs) {
      return
    }
    this.view = { ...this.view, pending: spokenText(held, this.ledger.tentative()) }
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      void this.commit()
    }, this.deps.responseDelayMs())
    this.publish()
  }

  private async commit(flush: 'silence' | 'send' = 'silence'): Promise<void> {
    if (this.exited) {
      return
    }
    // The wait came due with no chat seam bound: hold the words in the machine; the rebind arms them again.
    if (this.deps.chatBound?.() === false) {
      this.view = { ...this.view, pending: null }
      this.publish()
      return
    }
    const generation = this.generation
    this.view = { ...this.view, pending: null }
    // The commit itself is the machine's call: its event sends the buffer or steers the turn.
    const outcome = this.machine.dispatch({ type: flush })
    this.publish()
    const effect = outcome.effects[0]
    if (effect?.kind === 'steer') {
      // The turn keeps running; the send that started it still owns the loop's reply wait.
      const steered = await this.deps.steer(effect.text)
      if (!steered.steered && !this.exited && generation === this.generation) {
        this.deps.onNotice('send-failed')
        this.exit()
      }
      return
    }
    if (effect?.kind !== 'send') {
      return
    }
    // The turn begins with its send; briefings the model authors while it streams are kept for its reply.
    this.deps.readout.beginTurn()
    const delivered = await this.deps.send(effect.text)
    if (this.exited || generation !== this.generation) {
      return
    }
    if (!delivered.sent) {
      this.deps.onNotice('send-failed')
      this.exit()
      return
    }
    // The reply ends the turn; steering still waiting out its window died with it.
    this.clearPendingTimer()
    this.view = { ...this.view, pending: null }
    const briefing = this.deps.readout.settleBriefing()
    const replied = this.machine.dispatch({
      type: 'reply',
      text: delivered.reply,
      ...(briefing !== null ? { briefing } : {})
    })
    this.view = { ...this.view, reply: delivered.reply }
    this.publish()
    const speak = effectOf(replied.effects, 'speak')
    // The foreground policy reads the accept: a reply the loop took while away parks its playback
    // for the restore, and a turn that straddled the away chimes as it answers.
    if (!this.foreground.replyAccepted(this.machine.getState().visibility, speak)) {
      return
    }
    if (!speak) {
      // Muted by setting, or nothing to say: the machine is already listening again.
      return
    }
    // Playback is held open here: its settle — end, interruption, failure — walks the machine back
    // to listening, or never has to because a barge-in or exit already did.
    await this.deps.readout.play({ text: speak.text, locale: speak.locale ?? null })
    if (this.exited || generation !== this.generation) {
      return
    }
    if (this.machine.getState().route === 'speaking') {
      this.machine.dispatch({ type: 'playbackEnd' })
      this.publish()
    }
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
  }

  private publish(): void {
    const state = this.machine.getState()
    this.view = {
      route: state.route,
      transcript: spokenText([...state.buffer, ...state.steering], this.ledger.tentative()),
      pending: this.view.pending,
      reply: this.view.reply
    }
    this.deps.onState(this.view)
  }
}

import {
  createVoiceLoopMachine,
  defaultVoiceLoopThresholds,
  type VoiceLoopThresholds
} from '../../../src/shared/voice/voice-loop-machine'
import type {
  VoiceLoopShellDeps,
  VoiceLoopTranscriptRead,
  VoiceLoopView
} from './voice-loop-shell-contract'

// Same pace the dictation drain reads at; the bridge has no push lane for transcripts.
const DEFAULT_READ_INTERVAL_MS = 150

/**
 * Binds T1's voice-loop machine to the phone's seams. The machine owns every route and buffer
 * decision; this shell owns only what the machine's table does not model: when to poll, the
 * response-delay window that makes a finalized utterance — or held steering — revocable, and
 * platform release order. The delay window arms after the machine's own silence window has
 * passed with the words held, so the commit still happens through the machine's own event,
 * sending the buffer in listening or steering the running turn in thinking.
 */
export class VoiceLoopShell {
  private readonly thresholds: VoiceLoopThresholds
  private readonly readIntervalMs: number
  private readonly machine: ReturnType<typeof createVoiceLoopMachine>
  private view: VoiceLoopView = { route: 'idle', transcript: '', pending: null, reply: null }
  private generation = 0
  private readTimer: ReturnType<typeof setTimeout> | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private revision = -1
  private committedSeen = ''
  private tentativeSeen = ''
  private lastActivityAt: number | null = null
  private suppressPending = false
  private starting = false
  private started = false
  private exited = false
  private armedSpeech = false
  private micOpened = false
  private screenHeld = false

  constructor(private readonly deps: VoiceLoopShellDeps) {
    this.thresholds = { ...defaultVoiceLoopThresholds, ...deps.thresholds }
    this.readIntervalMs = deps.readIntervalMs ?? DEFAULT_READ_INTERVAL_MS
    this.machine = createVoiceLoopMachine({ now: deps.now, thresholds: this.thresholds })
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
        this.releasePlatform()
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
    this.armedSpeech = true
    this.deps.holdScreen()
    this.screenHeld = true
    const micOpen = await this.deps.openMic()
    if (this.exited) {
      // The exit before the open could not release what had not opened; the late open is ours.
      this.micOpened = micOpen
      this.releasePlatform()
      return
    }
    if (!micOpen) {
      this.starting = false
      this.deps.onNotice('mic-unavailable')
      this.releasePlatform()
      this.settleClosed()
      return
    }
    this.micOpened = true
    this.starting = false
    this.started = true
    this.machine.dispatch({ type: 'start' })
    this.publish()
    this.scheduleRead()
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

  /** Ends the loop: the machine settles terminal, then the recognizer, mic and screen release. */
  exit(): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.starting = false
    this.started = false
    this.generation += 1
    if (this.readTimer !== null) {
      clearTimeout(this.readTimer)
      this.readTimer = null
    }
    this.clearPendingTimer()
    if (this.machine.getState().route !== 'closed') {
      this.machine.dispatch({ type: 'closeTab' })
    }
    this.releasePlatform()
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

  // Each release clears its flag, so an exit racing a pending open releases everything once.
  private releasePlatform(): void {
    if (this.armedSpeech) {
      this.armedSpeech = false
      this.deps.cancelSpeech()
    }
    if (this.micOpened) {
      this.micOpened = false
      this.deps.closeMic()
    }
    if (this.screenHeld) {
      this.screenHeld = false
      this.deps.releaseScreen()
    }
  }

  private scheduleRead(): void {
    if (this.exited || this.readTimer !== null) {
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
    if (read.revision <= this.revision) {
      return false
    }
    this.revision = read.revision
    const committed = read.committed.trim()
    const seen = this.committedSeen
    let spoke = committed !== seen
    if (committed.startsWith(seen) && committed !== seen) {
      // Committed text is the whole final text so far: feed the machine only the new words.
      const delta = committed.slice(seen.length).trim()
      if (delta) {
        this.machine.dispatch({ type: 'speech', text: delta })
      }
      this.committedSeen = committed
    } else if (committed !== seen) {
      // A rewrite of already-committed words has no machine event; adopt it and wait for more.
      this.committedSeen = committed
    }
    const tentative = read.tentative.trim()
    spoke = spoke || tentative !== this.tentativeSeen
    this.tentativeSeen = tentative
    if (spoke) {
      this.lastActivityAt = this.deps.now()
      // Speech during the wait un-finalizes the utterance: the buffer keeps growing.
      if (this.view.pending !== null) {
        this.clearPendingTimer()
        this.view = { ...this.view, pending: null }
      }
      this.suppressPending = false
    }
    return spoke
  }

  private armPendingIfQuiet(): void {
    if (this.view.pending !== null || this.suppressPending) {
      return
    }
    const state = this.machine.getState()
    // The wait arms for either commit: the running turn's steer or the next send's buffer.
    const held =
      state.route === 'thinking' ? state.steering : state.route === 'listening' ? state.buffer : []
    if (held.length === 0 || this.lastActivityAt === null) {
      return
    }
    if (this.deps.now() - this.lastActivityAt < this.thresholds.silenceWindowMs) {
      return
    }
    this.view = { ...this.view, pending: spokenText(held, this.tentativeSeen) }
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
    this.machine.dispatch({ type: 'reply', text: delivered.reply })
    // T5 renders the reply silently, so playback is over the moment it renders; T6 holds this open.
    this.machine.dispatch({ type: 'playbackEnd' })
    this.view = { ...this.view, reply: delivered.reply }
    this.publish()
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
      transcript: spokenText([...state.buffer, ...state.steering], this.tentativeSeen),
      pending: this.view.pending,
      reply: this.view.reply
    }
    this.deps.onState(this.view)
  }
}

/** The utterance as it stands: the machine's held chunks, buffered or steering, plus the tail. */
function spokenText(chunks: readonly string[], tentative: string): string {
  const spoken = chunks.filter(Boolean).join(' ')
  const tail = tentative.trim()
  return spoken && tail ? `${spoken} ${tail}` : spoken || tail
}

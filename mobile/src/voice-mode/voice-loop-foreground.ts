import type {
  VoiceLoopEffect,
  VoiceLoopRoute,
  VoiceLoopVisibility
} from '../../../src/shared/voice/voice-loop-machine'
import type { OnDeviceTone } from '../platform/tone/on-device-tone-contract'

/** The playback a backgrounded loop parked: the machine's own speak effect, held for the restore. */
export type VoiceLoopDeferredSpeak = Extract<VoiceLoopEffect, { kind: 'speak' }>

export type VoiceLoopForegroundDeps = {
  /** Null when the page lacks the verb grant: the restore chime is silence, never a break. */
  readonly tone: OnDeviceTone | null
}

/**
 * The loop's foreground policy: everything the app's comings and goings decide, kept out of the
 * shell's platform hands. A reply accepted while the loop is backgrounded parks its playback for
 * the restore and earns that window's one chime; a turn whose send preceded the background window
 * earns the same chime when its reply accepts after the restore. One chime per away window however
 * many replies land in it, and none at all for a window nothing advanced in — buffered words, a
 * still-running turn or plain quiet never sound one. The chime is the tone seam's to sound; the
 * parked playback and the microphone are the shell's to serve, in that order.
 */
export class VoiceLoopForeground {
  private backgrounded = false
  private earned = false
  private chimed = false
  private straddling = false
  private deferred: VoiceLoopDeferredSpeak | null = null

  constructor(private readonly deps: VoiceLoopForegroundDeps) {}

  isBackgrounded(): boolean {
    return this.backgrounded
  }

  /** The app left the foreground; the route names whether the loop's own turn is still running. */
  background(route: VoiceLoopRoute): void {
    if (this.backgrounded) {
      // A second leaving while still away is the same window; only its straddling may have moved.
      this.straddling = this.straddling || route === 'thinking'
      return
    }
    this.backgrounded = true
    this.chimed = false
    this.earned = false
    this.straddling = route === 'thinking'
  }

  /**
   * A reply event the machine just accepted, with the visibility it accepted under: one backgrounded
   * parks the playback for the restore, and an away-straddling turn chimes as it answers. Returns
   * whether the shell may play now.
   */
  replyAccepted(visibility: VoiceLoopVisibility, speak: VoiceLoopDeferredSpeak | null): boolean {
    const straddled = this.straddling
    this.straddling = false
    if (visibility === 'background') {
      this.earned = true
      this.deferred = speak
      return false
    }
    if (straddled) {
      this.chime()
    }
    return true
  }

  /** The app came back: the window's chime, if earned, and the playback that waited for it. */
  restore(): VoiceLoopDeferredSpeak | null {
    this.backgrounded = false
    const deferred = this.deferred
    this.deferred = null
    if (this.earned) {
      this.earned = false
      this.chime()
    }
    return deferred
  }

  /** The loop ended: nothing it parked or earned survives it. */
  reset(): void {
    this.backgrounded = false
    this.earned = false
    this.chimed = false
    this.straddling = false
    this.deferred = null
  }

  private chime(): void {
    if (this.chimed) {
      return
    }
    this.chimed = true
    this.deps.tone?.play('restore')
  }
}

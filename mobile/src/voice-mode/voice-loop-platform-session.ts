import type { VoiceLoopShellDeps } from './voice-loop-shell-contract'

/**
 * The platform resources one loop run holds open — the armed recognizer, the open microphone,
 * the kept-on screen — each tracked so its release is idempotent and ordered: the speaker goes
 * silent first, then the recognizer, the microphone and the screen give way. The startup and
 * foreground races resolve against these holds: an exit or a leave that lands while an open is
 * still resolving finds every earlier hold released exactly once, and the late open is never
 * adopted silently.
 */
export class VoiceLoopPlatformSession {
  private armedSpeech = false
  private micOpened = false
  private screenHeld = false

  constructor(private readonly deps: VoiceLoopShellDeps) {}

  /** The recognizer armed; its cancellation is this session's from here on. */
  markSpeechArmed(): void {
    this.armedSpeech = true
  }

  holdScreen(): void {
    this.deps.holdScreen()
    this.screenHeld = true
  }

  /** A microphone the loop adopted: its reads may run and its close is this session's. */
  markMicOpened(): void {
    this.micOpened = true
  }

  /** Closes the microphone if the loop holds it; idempotent over the native pause listener. */
  closeMic(): void {
    if (this.micOpened) {
      this.micOpened = false
      this.deps.closeMic()
    }
  }

  /** Releases everything the loop holds: the speaker, then the recognizer, the mic and the screen. */
  release(): void {
    // Silence playback first: a loop that ends must not keep the speaker past its mic and screen.
    this.deps.readout.stop()
    if (this.armedSpeech) {
      this.armedSpeech = false
      this.deps.cancelSpeech()
    }
    this.closeMic()
    if (this.screenHeld) {
      this.screenHeld = false
      this.deps.releaseScreen()
    }
  }
}

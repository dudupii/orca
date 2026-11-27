import type { VoiceLoopTranscriptRead } from './voice-loop-shell-contract'

/** What one read changed: new words for the machine, and whether the drawn utterance moved. */
export type VoiceLoopTranscriptDelta = {
  /** New committed words since the last read; null when the read rewrote or repeated what was seen. */
  readonly delta: string | null
  /** The drawn words changed: committed text or the tentative tail moved. */
  readonly spoke: boolean
}

/**
 * The transcript's bookkeeping, apart from the machine's routing: which read is new, which of its
 * committed words the machine has not been fed, the tentative tail the view draws, and when the
 * words last moved. The shell asks; this ledger remembers.
 */
export class VoiceLoopTranscriptLedger {
  private revision = -1
  private committedSeen = ''
  private tentativeSeen = ''
  private lastActivityAt: number | null = null

  /** Records one read; a repeated revision changes nothing. */
  ingest(read: VoiceLoopTranscriptRead, now: number): VoiceLoopTranscriptDelta {
    if (read.revision <= this.revision) {
      return { delta: null, spoke: false }
    }
    this.revision = read.revision
    const committed = read.committed.trim()
    const seen = this.committedSeen
    let delta: string | null = null
    if (committed.startsWith(seen) && committed !== seen) {
      // Committed text is the whole final text so far: only the new words are a delta.
      delta = committed.slice(seen.length).trim() || null
      this.committedSeen = committed
    } else if (committed !== seen) {
      // A rewrite of already-committed words has no machine event; adopt it and wait for more.
      this.committedSeen = committed
    }
    const tentative = read.tentative.trim()
    const spoke = committed !== seen || tentative !== this.tentativeSeen
    this.tentativeSeen = tentative
    if (spoke) {
      this.lastActivityAt = now
    }
    return { delta, spoke }
  }

  /** When the words last moved, for the silence window that arms the wait. */
  activityAt(): number | null {
    return this.lastActivityAt
  }

  /** The tentative tail as it stands, for the drawn utterance. */
  tentative(): string {
    return this.tentativeSeen
  }
}

/** The utterance as it stands: the machine's held chunks, buffered or steering, plus the tail. */
export function spokenText(chunks: readonly string[], tentative: string): string {
  const spoken = chunks.filter(Boolean).join(' ')
  const tail = tentative.trim()
  return spoken && tail ? `${spoken} ${tail}` : spoken || tail
}

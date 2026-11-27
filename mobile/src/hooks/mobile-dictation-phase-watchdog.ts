import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { pairedDictationFinishTimeoutMs } from '../../../src/shared/dictation-finish-deadlines'
import { MOBILE_DICTATION_RECONNECT_GRACE_MS } from '../../../src/shared/rpc-contract/speech/speech-params'
import type { DictationStatus } from './mobile-dictation-session-state'
import type { MobileDictationRun } from './mobile-dictation-engine-run'
import type { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'

// A press must always reach a working mic: these bounds end a run the host never answers, in a state Retry can act on.
export const MOBILE_DICTATION_STALLED_ERROR_MESSAGE =
  'Voice dictation stopped because the transcript did not arrive. Try again.'

// The run's host client was replaced mid-run; the new host does not know this dictation, so Retry replays it there.
export const MOBILE_DICTATION_CLIENT_REPLACED_ERROR_MESSAGE =
  'Voice dictation stopped because the connection was replaced. Try again.'

// Past this, a starting dictation may be superseded by a new press. Its own host waits are bounded by the
// request timeouts, except a microphone open that never answers, which no timeout anywhere covers.
export const MOBILE_DICTATION_START_STALL_MS = 60_000

// The finish request's own deadline, plus one reconnect grace for the audio sends it waits out first.
export function mobileDictationProcessingDeadlineMs(sentAudioSeconds: number): number {
  return pairedDictationFinishTimeoutMs(sentAudioSeconds) + MOBILE_DICTATION_RECONNECT_GRACE_MS
}

// One bound per phase: processing fails the run outright (Retry keeps the recording); a stalled start only
// lets a new press supersede it, because an open may still be waiting on the OS permission prompt.
class MobileDictationPhaseWatchdog {
  private failTimer: ReturnType<typeof setTimeout> | null = null
  private stallTimer: ReturnType<typeof setTimeout> | null = null

  armProcessing(fail: () => void, deadlineMs: number): void {
    this.clearFail()
    this.failTimer = setTimeout(fail, deadlineMs)
  }

  armStartStall(stall: () => void): void {
    this.clearStall()
    this.stallTimer = setTimeout(stall, MOBILE_DICTATION_START_STALL_MS)
  }

  clear(): void {
    this.clearFail()
    this.clearStall()
  }

  private clearFail(): void {
    if (this.failTimer !== null) {
      clearTimeout(this.failTimer)
      this.failTimer = null
    }
  }

  private clearStall(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }
}

type MobileDictationPhaseBoundsOptions = {
  readonly status: RefObject<DictationStatus>
  readonly activeId: RefObject<string | null>
  readonly pendingAudioBudget: RefObject<MobileDictationPendingAudioBudget>
  // The run exists only after first render; read it when a bound fires, not when it is armed.
  readonly run: RefObject<MobileDictationRun | null>
}

// Bounds the phases a press cannot get out of on its own. Every status change is reported here, so the
// bounds re-arm with them: processing must end in a failure Retry can act on, and a start that never gets
// going only opens itself to supersession by a new press.
export function useMobileDictationPhaseBounds(options: MobileDictationPhaseBoundsOptions): {
  readonly onStatusChanged: (next: DictationStatus) => void
  // True past the start stall bound: a starting run a new press may supersede, because nothing is ending it.
  readonly startStalled: boolean
  readonly startStalledRef: RefObject<boolean>
} {
  const { status, activeId, pendingAudioBudget, run } = options
  const [startStalled, setStartStalled] = useState(false)
  const startStalledRef = useRef(false)
  const watchdogRef = useRef(new MobileDictationPhaseWatchdog())
  useEffect(() => () => watchdogRef.current.clear(), [])

  const onStatusChanged = useCallback(
    (next: DictationStatus) => {
      if (startStalledRef.current) {
        startStalledRef.current = false
        setStartStalled(false)
      }
      const dictationId = activeId.current
      if (next === 'processing' && dictationId !== null) {
        watchdogRef.current.armProcessing(() => {
          const current = activeId.current
          const stalled = run.current
          if (current === dictationId && stalled !== null) {
            stalled.failActiveDictation(current, new Error(MOBILE_DICTATION_STALLED_ERROR_MESSAGE))
          }
        }, mobileDictationProcessingDeadlineMs(pendingAudioBudget.current.sentAudioSeconds))
        return
      }
      if (next === 'starting') {
        watchdogRef.current.armStartStall(() => {
          if (status.current === 'starting') {
            startStalledRef.current = true
            setStartStalled(true)
          }
        })
        return
      }
      watchdogRef.current.clear()
    },
    [activeId, pendingAudioBudget, run, status]
  )

  return useMemo(
    () => ({ onStatusChanged, startStalled, startStalledRef }),
    [onStatusChanged, startStalled, startStalledRef]
  )
}

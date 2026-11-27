import type { RefObject } from 'react'
import { dictationSessionErrorMessage } from '../dictation/mobile-dictation-setup'
import {
  claimCaptureSession,
  hasOtherCaptureSessionClaim,
  releaseCaptureSession,
  type CaptureSessionClaim
} from '../platform/audio-capture/capture-owner'
import type { DictationCapture } from '../platform/audio-capture/dictation-capture-contract'

type OpenMobileDictationCaptureOptions = {
  capture: DictationCapture
  // Same start generation and still enabled.
  isCurrent: () => boolean
  isCurrentGeneration: () => boolean
  // Where the open's claim on the shared audio session is published: recording keeps it until the mic closes.
  captureClaim: RefObject<CaptureSessionClaim | null>
  setIdle: () => void
  // Called just before begin, so chunks the microphone delivers from then on are held.
  hold: () => void
  close: () => void
}

// Native recording can throw part-way; treat it like a refused begin so the microphone is released.
function beginCapture(capture: DictationCapture): boolean {
  try {
    return capture.begin()
  } catch {
    return false
  }
}

// Opens the microphone and starts recording from the tap; false when a newer start, cancel or disable superseded it meanwhile.
export async function openMobileDictationCapture(
  options: OpenMobileDictationCaptureOptions
): Promise<boolean> {
  const { capture } = options
  // The open claims the shared audio session from request to close, so a stale open that settles
  // late can tell its own abandoned session from one another owner took over.
  const claim = claimCaptureSession()
  options.captureClaim.current = claim
  const dropClaim = () => {
    releaseCaptureSession(claim)
    if (options.captureClaim.current === claim) {
      options.captureClaim.current = null
    }
  }
  let opened
  try {
    opened = await capture.open()
  } catch (err) {
    dropClaim()
    // Stale refusal must neither idle the replacement nor toast over the closure already reported by disable.
    if (!options.isCurrent()) {
      return false
    }
    // A page without audio grants can refuse capture; return to idle before rethrowing its message so starting cannot get stuck.
    options.setIdle()
    throw err instanceof Error ? err : new Error(String(err))
  }
  if (!options.isCurrent()) {
    // Superseded by a newer start, a cancel, or a disable. Release the shared session only when no
    // other owner (the replacement's open, voice mode) holds it: releasing would tear down their
    // microphone, while skipping it leaves only this open's own hold for the next close to free.
    const otherOwner = hasOtherCaptureSessionClaim(claim)
    dropClaim()
    if (!otherOwner) {
      capture.release()
      if (options.isCurrentGeneration()) {
        options.setIdle()
      }
    }
    return false
  }
  if (!opened.ok) {
    dropClaim()
    options.setIdle()
    throw new Error(dictationSessionErrorMessage(opened.reason))
  }
  options.hold()
  if (!beginCapture(capture)) {
    options.close()
    options.setIdle()
    throw new Error(dictationSessionErrorMessage('recording-failed'))
  }
  return true
}

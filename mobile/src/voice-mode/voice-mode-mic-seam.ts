import type { RefObject } from 'react'
import {
  claimCaptureSession,
  releaseCaptureSession,
  type CaptureSessionClaim
} from '../platform/audio-capture/capture-owner'
import { nativeMicrophoneScreenLock } from '../platform/audio-capture/native-audio-device'
import type {
  DictationCapture,
  DictationCaptureOpen
} from '../platform/audio-capture/dictation-capture-contract'
import type { VoiceLoopShellDeps } from './voice-loop-shell-contract'

// The loop's microphone seam: the open claims the shared audio session until closeMic releases it,
// so a stale dictation open that settles late can tell the loop's session from its own abandoned one.
export function createVoiceModeMicSeam(
  capture: RefObject<DictationCapture>
): Pick<VoiceLoopShellDeps, 'openMic' | 'closeMic' | 'holdScreen' | 'releaseScreen'> {
  // The live open's claim; released by closeMic, or by a refused open or begin.
  let micClaim: CaptureSessionClaim | null = null
  const releaseMicClaim = () => {
    if (micClaim !== null) {
      releaseCaptureSession(micClaim)
      micClaim = null
    }
  }
  return {
    openMic: async () => {
      micClaim = claimCaptureSession()
      let opened: DictationCaptureOpen
      try {
        opened = await capture.current.open()
      } catch {
        // The capture contract lets a bridge refusal reject; that is a refused open here.
        releaseMicClaim()
        return false
      }
      if (!opened.ok) {
        releaseMicClaim()
        return false
      }
      try {
        if (!capture.current.begin()) {
          // Native recording can throw part-way; treat it like a refused begin so the microphone is released.
          void capture.current.end()
          releaseMicClaim()
          return false
        }
      } catch {
        void capture.current.end()
        releaseMicClaim()
        return false
      }
      return true
    },
    closeMic: () => {
      releaseMicClaim()
      try {
        void capture.current.end()
      } catch (err) {
        // Cleanup must keep going when a synchronous seam throws, or the mic would leak.
        console.error('Failed to close the voice-mode microphone', err)
      }
    },
    holdScreen: () => nativeMicrophoneScreenLock.hold(),
    releaseScreen: () => nativeMicrophoneScreenLock.release()
  }
}

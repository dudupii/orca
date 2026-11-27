// One microphone seam serves several owners: every dictation start's open and a voice-mode loop
// claim it, and the claim lives from open until that owner's session closes. A stale open that
// settles late can then tell its own abandoned session from a live one, and tear the shared audio
// down only when nobody else took it over.
export type CaptureSessionClaim = symbol

const claims = new Set<CaptureSessionClaim>()

export function claimCaptureSession(): CaptureSessionClaim {
  const claim = Symbol('capture-session')
  claims.add(claim)
  return claim
}

export function releaseCaptureSession(claim: CaptureSessionClaim): void {
  claims.delete(claim)
}

// True while another open still holds the shared session: releasing would tear down their microphone.
export function hasOtherCaptureSessionClaim(claim: CaptureSessionClaim): boolean {
  for (const held of claims) {
    if (held !== claim) {
      return true
    }
  }
  return false
}

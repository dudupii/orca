import { UpdaterInstallExecution } from '../lifecycle/updater-install-execution'

/** Tracks the missing-manifest prerelease fallback: when a pinned primary tag's manifest 404s
 *  mid-check, one retry against the previous feed's tag must suppress and settle both attempts'
 *  failures without surfacing either as an error. */
export abstract class UpdaterPrereleaseFallback extends UpdaterInstallExecution {
  protected clearPrereleaseFallbackContextIfSettled(): void {
    if (
      this.pendingPrereleaseFallback?.fallbackResultHandled &&
      !this.pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey &&
      !this.pendingPrereleaseFallback.suppressedPrimaryEventFailure &&
      !this.pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey &&
      !this.pendingPrereleaseFallback.suppressedFallbackEventFailureKey
    ) {
      this.clearPrereleaseFallbackContext()
    }
  }

  protected getMissingManifestPrereleaseFallbackUserInitiated(): boolean | null {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return null
    }
    return this.pendingPrereleaseFallback.userInitiated
  }

  protected markMissingManifestPrereleaseFallbackChecking(): void {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return
    }
    this.pendingPrereleaseFallback.fallbackCheckingForUpdateSeen = true
  }

  protected consumeMissingManifestPrereleaseFallbackResult(): { userInitiated: boolean } | null {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return null
    }
    const result = { userInitiated: this.pendingPrereleaseFallback.userInitiated }
    this.pendingPrereleaseFallback.fallbackResultHandled = true
    this.clearPrereleaseFallbackContextIfSettled()
    return result
  }

  protected suppressMissingManifestPrereleaseFallbackPromiseFailure(message: string): void {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return
    }
    this.pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey = this.getCheckFailureKey(
      message,
      this.pendingPrereleaseFallback.userInitiated
    )
  }

  protected shouldSuppressMissingManifestPrereleaseFallbackEvent(
    message: string,
    error: unknown
  ): boolean {
    if (!this.pendingPrereleaseFallback?.retryLaunched) {
      return false
    }
    const failureKey = this.getCheckFailureKey(
      message,
      this.pendingPrereleaseFallback.userInitiated
    )
    const primaryEventSuppression = this.pendingPrereleaseFallback.suppressedPrimaryEventFailure
    if (primaryEventSuppression?.failureKey === failureKey) {
      const isPrimaryPromisePair = primaryEventSuppression.error === error
      // After fallback starts, identical messages may be its own errors; message matching alone is unsafe.
      if (isPrimaryPromisePair || !this.pendingPrereleaseFallback.fallbackCheckingForUpdateSeen) {
        this.pendingPrereleaseFallback.suppressedPrimaryEventFailure = null
        this.clearPrereleaseFallbackContextIfSettled()
        return true
      }
    }
    if (this.pendingPrereleaseFallback.suppressedFallbackEventFailureKey === failureKey) {
      this.pendingPrereleaseFallback.suppressedFallbackEventFailureKey = null
      this.clearPrereleaseFallbackContextIfSettled()
      return true
    }
    return false
  }

  protected markMissingManifestPrereleaseFallbackPromiseHandled(message: string): void {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return
    }
    this.pendingPrereleaseFallback.suppressedFallbackEventFailureKey = this.getCheckFailureKey(
      message,
      this.pendingPrereleaseFallback.userInitiated
    )
  }
}

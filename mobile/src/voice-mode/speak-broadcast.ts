import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { VoiceSpeakBroadcast } from './voice-readout-contract'

// The notifications wire carries speak broadcasts alongside desktop pushes; these narrow what
// arrives into the readout's briefing shape and nothing else. Speak never presents an OS
// notification, so the only phone-side consumer is voice mode's readout.

type WireNotification = {
  type?: unknown
  source?: unknown
  body?: unknown
  speakLang?: unknown
  speakSession?: unknown
}

/** Reads one wire event as a speak broadcast; null for every other notification or control frame. */
export function readSpeakBroadcast(event: unknown): VoiceSpeakBroadcast | null {
  if (typeof event !== 'object' || event === null) {
    return null
  }
  const wire = event as WireNotification
  if (wire.type !== 'notification' || wire.source !== 'speak') {
    return null
  }
  if (typeof wire.body !== 'string' || wire.body.length === 0) {
    return null
  }
  return {
    text: wire.body,
    lang: typeof wire.speakLang === 'string' && wire.speakLang.length > 0 ? wire.speakLang : null,
    session:
      typeof wire.speakSession === 'string' && wire.speakSession.length > 0
        ? wire.speakSession
        : null
  }
}

/**
 * Subscribes the voice loop to the host's speak broadcasts. The same stream the phone's push
 * path reads, desktop-suppressed events included, so a broadcast the desktop muted still speaks.
 */
export function subscribeToSpeakBroadcasts(
  client: RpcClient,
  onBroadcast: (broadcast: VoiceSpeakBroadcast) => void
): () => void {
  return client.subscribe(
    'notifications.subscribe',
    { includeDesktopSuppressed: true },
    (data: unknown) => {
      const broadcast = readSpeakBroadcast(data)
      if (broadcast !== null) {
        onBroadcast(broadcast)
      }
    }
  )
}

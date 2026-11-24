import type { OnDeviceTtsChannelRead } from '../platform/tts/on-device-tts-contract'
import type {
  VoiceReadout,
  VoiceReadoutDeps,
  VoiceReadoutEnd,
  VoiceSpeakBroadcast
} from './voice-readout-contract'

// Same pace the loop polls transcripts; the bridge has no push lane for endings either.
const PLAYBACK_READ_INTERVAL_MS = 150

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The speaking side's one playback owner (see voice-readout-contract). Playback failures settle
 * 'failed' rather than reject: a muted or broken speaker must end the turn's playback, never the loop.
 */
export function createVoiceReadout(deps: VoiceReadoutDeps): VoiceReadout {
  let briefing: VoiceSpeakBroadcast | null = null

  // Polls the claim's revision until the shell reports its ending; a higher revision means a newer
  // claim displaced this one, which is an interruption however the shell words it.
  async function playClaimed(
    playback: NonNullable<VoiceReadoutDeps['playback']>,
    revision: number
  ): Promise<VoiceReadoutEnd> {
    for (;;) {
      await sleep(PLAYBACK_READ_INTERVAL_MS)
      let read: OnDeviceTtsChannelRead
      try {
        read = await playback.read()
      } catch {
        return 'failed'
      }
      if (read.revision > revision) {
        return 'interrupted'
      }
      if (read.revision === revision) {
        if (read.status === 'done' || read.status === 'stopped') {
          return read.status
        }
        if (read.status === 'failed') {
          return 'failed'
        }
      }
      // Still speaking under this revision: keep polling.
    }
  }

  return {
    beginTurn: () => {
      briefing = null
    },
    briefingArrived: (broadcast) => {
      briefing = broadcast
    },
    settleBriefing: () => (briefing === null ? null : { text: briefing.text, lang: briefing.lang }),
    play: async (utterance) => {
      const playback = deps.playback
      if (playback === null) {
        // An older shell grants no tts verb: the reply stays silent, but the turn completes.
        return 'failed'
      }
      try {
        // A lang-less utterance gets its locale here, once, where both play paths — the reply's
        // own and the restore's parked utterance — converge; the model's named locale passes as-is.
        const locale =
          utterance.locale !== null || deps.resolveLocale === undefined
            ? utterance.locale
            : deps.resolveLocale(utterance.text)
        const claimed = await playback.speak({ text: utterance.text, locale })
        return await playClaimed(playback, claimed.revision)
      } catch {
        return 'failed'
      }
    },
    stop: () => {
      if (deps.playback === null) {
        return
      }
      // A stop on a dead bridge must not throw into the loop's exit path.
      void deps.playback.stop().catch(() => undefined)
    }
  }
}

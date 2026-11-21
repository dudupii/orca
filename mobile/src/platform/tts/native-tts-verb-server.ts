import {
  ttsParamsSchema,
  type BridgeTtsFailure,
  type BridgeTtsRead
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-tts-verbs'
import type { NativeTtsServer } from './native-tts'
import type { OnDeviceTtsResult } from './on-device-tts-contract'

// The shell side of native.tts.act. Playback and its interruption contract live in the tts seam's
// server; this keeps only what the bridge needs on top of it: a revision per claim, so a poll can
// tell its own utterance's ending from a newer claim displacing it.

export type NativeTtsVerbServer = {
  readonly serve: (params: unknown) => Promise<unknown>
  readonly dispose: () => void
}

// A newer engine's code the shipped page does not know still means a plain failure.
function failureOf(code: string): BridgeTtsFailure {
  return code === 'unsupported' || code === 'busy' ? code : 'failed'
}

function readOf(revision: number, result: OnDeviceTtsResult): BridgeTtsRead {
  return {
    revision,
    status: result.status,
    reason: result.status === 'failed' ? failureOf(result.reason) : null
  }
}

export function createNativeTtsVerbServer(tts: NativeTtsServer): NativeTtsVerbServer {
  // Revision 0 is the never-claimed floor; every speak claims the next one, so a poll holding an
  // older revision knows a newer claim displaced it even before its own ending is written.
  let latest: BridgeTtsRead = { revision: 0, status: 'idle', reason: null }
  let next = 1

  return {
    serve: async (params) => {
      const call = ttsParamsSchema.parse(params)
      switch (call.action) {
        case 'speak': {
          // Claimed before the engine call: the reply settles at claim time, never at playback end,
          // so the page's poll — not this reply — carries how the utterance ended.
          const revision = next++
          latest = { revision, status: 'speaking', reason: null }
          void tts.speak({ text: call.text, locale: call.locale }).then((result) => {
            // An interrupted claim settles after a newer one already owns the read; its ending
            // stays with its own revision's poll and must not overwrite the newer claim's.
            if (latest.revision <= revision) {
              latest = readOf(revision, result)
            }
          })
          return { revision }
        }
        case 'stop':
          // The seam settles the live utterance as stopped; that settle writes latest itself.
          tts.stop()
          return {}
        case 'read':
          return { ...latest }
      }
    },
    dispose: () => tts.dispose()
  }
}

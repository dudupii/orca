import { useMemo } from 'react'
import {
  useNativeVerbs,
  type NativeVerbs
} from '../../mobile-web-shell/bridge/native-capabilities/use-native-verbs'
import type {
  OnDeviceTtsChannel,
  OnDeviceTtsFailure,
  OnDeviceTtsUtterance
} from './on-device-tts-contract'

// A newer shell's code the page does not know still means a plain failure.
function failureOf(code: string | null): OnDeviceTtsFailure | null {
  if (code === null) {
    return null
  }
  return code === 'unsupported' || code === 'busy' ? code : 'failed'
}

function createPageTtsChannel(verbs: NativeVerbs): OnDeviceTtsChannel {
  return {
    speak: (utterance: OnDeviceTtsUtterance) =>
      verbs.ttsSpeak(utterance.text, utterance.locale).then((revision) => ({ revision })),
    stop: () => verbs.ttsStop(),
    read: async () => {
      const read = await verbs.ttsRead()
      return { revision: read.revision, status: read.status, reason: failureOf(read.reason) }
    }
  }
}

// Null on a shell without the verb, so voice mode's replies render silently exactly as before.
export function useOnDeviceTts(): OnDeviceTtsChannel | null {
  const verbs = useNativeVerbs()
  return useMemo(() => (verbs.canSpeakTts ? createPageTtsChannel(verbs) : null), [verbs])
}

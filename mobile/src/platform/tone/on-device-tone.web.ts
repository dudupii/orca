import { useMemo } from 'react'
import {
  useNativeVerbs,
  type NativeVerbs
} from '../../mobile-web-shell/bridge/native-capabilities/use-native-verbs'
import type { OnDeviceTone, OnDeviceToneKind } from './on-device-tone-contract'

function createPageTone(verbs: Pick<NativeVerbs, 'tonePlay'>): OnDeviceTone {
  return {
    // Fire-and-forget: a refused or failed chime is silence; surfacing it would turn decoration
    // into an error no caller can act on.
    play: (kind: OnDeviceToneKind) => {
      void verbs.tonePlay(kind).catch(() => {})
    }
  }
}

// Null on a shell without the verb, so the restore piece skips its blip exactly as before.
export function useOnDeviceTone(): OnDeviceTone | null {
  const verbs = useNativeVerbs()
  return useMemo(() => (verbs.canPlayTone ? createPageTone(verbs) : null), [verbs])
}

import { toneParamsSchema } from '../../mobile-web-shell/bridge/native-capabilities/bridge-tone-verbs'
import type { OnDeviceToneKind } from './on-device-tone-contract'

// The shell side of native.tone.act. A chime is momentary and stateless — nothing to claim,
// settle or silence — so serving is one parse and one engine call.

export type NativeToneEngine = {
  // Synchronous and never throws: an unavailable chime is silence, never a failed reply.
  readonly play: (kind: OnDeviceToneKind) => void
}

export function serveNativeToneVerb(engine: NativeToneEngine, params: unknown): Promise<unknown> {
  const call = toneParamsSchema.parse(params)
  engine.play(call.kind)
  return Promise.resolve({})
}

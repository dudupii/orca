// The tone verb's table contract: pinned kinds, strict params, an empty reply, and the grant gate
// every native verb passes. The chime itself is device audio these tests cannot sound.
import { describe, expect, it } from 'vitest'

import {
  BRIDGE_NATIVE_VERBS,
  BRIDGE_NATIVE_VERB_NAMES,
  readBridgeNativeVerbCall
} from './bridge-native-verbs'
import {
  BRIDGE_TONE_KINDS,
  BRIDGE_TONE_VERB,
  toneParamsSchema,
  toneResultSchema
} from './bridge-tone-verbs'

describe('the native.tone.act table row', () => {
  it('is listed with params and result schemas', () => {
    expect(BRIDGE_NATIVE_VERB_NAMES).toContain(BRIDGE_TONE_VERB)
    expect(BRIDGE_NATIVE_VERBS[BRIDGE_TONE_VERB]).toEqual({
      params: toneParamsSchema,
      result: toneResultSchema
    })
  })

  it('parses each pinned kind and refuses a kind or field this build does not know', () => {
    for (const kind of BRIDGE_TONE_KINDS) {
      expect(toneParamsSchema.parse({ kind })).toEqual({ kind })
    }
    expect(toneParamsSchema.safeParse({ kind: 'victory' }).success).toBe(false)
    expect(toneParamsSchema.safeParse({ kind: 'restore', volume: 60 }).success).toBe(false)
    expect(toneResultSchema.parse({})).toEqual({})
    expect(toneResultSchema.safeParse({ played: true }).success).toBe(false)
  })

  it('serves the verb only to a page it was granted to', () => {
    const params = { kind: 'restore' }
    expect(
      readBridgeNativeVerbCall({ method: BRIDGE_TONE_VERB, granted: [BRIDGE_TONE_VERB], params })
    ).toEqual({ ok: true, verb: BRIDGE_TONE_VERB, params })
    const refused = readBridgeNativeVerbCall({ method: BRIDGE_TONE_VERB, granted: [], params })
    expect(refused).toMatchObject({ ok: false, refusal: 'ungranted' })
  })
})

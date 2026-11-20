import { describe, expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../../protocol-version'
import {
  MOBILE_RUNTIME_CAPABILITIES,
  VOICE_SPEAK_RUNTIME_CAPABILITY
} from './mobile-runtime-capabilities'

// Later tickets gate phone behaviour on this exact string; a moved or renamed capability strands them.
describe('voice.speak.v1 capability', () => {
  it('pins the fork-local host capability string', () => {
    expect(VOICE_SPEAK_RUNTIME_CAPABILITY).toBe('voice.speak.v1')
  })

  it('reaches clients through capability negotiation', () => {
    expect(MOBILE_RUNTIME_CAPABILITIES).toContain(VOICE_SPEAK_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(VOICE_SPEAK_RUNTIME_CAPABILITY)
  })
})

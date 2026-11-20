import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readVoiceSpeakLaunchInjection,
  voiceSpeakClientOnlineFrom,
  VOICE_SPEAK_PROMPT_APPEND,
  VOICE_SPEAK_TOKEN_HEADER
} from './voice-speak-injection'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function endpointRoot(contents: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-voice-speak-injection-'))
  roots.push(root)
  if (contents !== null) {
    mkdirSync(join(root, 'speak'), { recursive: true })
    writeFileSync(join(root, 'speak', 'speak-endpoint.json'), contents)
  }
  return root
}

const VALID_ENDPOINT = `${JSON.stringify({ port: 45123, token: 'token-1' })}\n`

describe('readVoiceSpeakLaunchInjection', () => {
  it('resolves the loopback speak endpoint for a spawn while a voice-capable phone is connected', async () => {
    const root = endpointRoot(VALID_ENDPOINT)
    await expect(
      readVoiceSpeakLaunchInjection({ clientOnline: () => true, userDataPath: root })
    ).resolves.toEqual({ serverUrl: 'http://127.0.0.1:45123/mcp', token: 'token-1' })
  })

  it('returns null while no voice-capable phone is connected, even with a published endpoint', async () => {
    const root = endpointRoot(VALID_ENDPOINT)
    await expect(
      readVoiceSpeakLaunchInjection({ clientOnline: () => false, userDataPath: root })
    ).resolves.toBeNull()
  })

  it('returns null when the speak endpoint file is missing: no tool over a dead address', async () => {
    const root = endpointRoot(null)
    await expect(
      readVoiceSpeakLaunchInjection({ clientOnline: () => true, userDataPath: root })
    ).resolves.toBeNull()
  })

  it('returns null for a malformed endpoint file rather than guessing an address', async () => {
    for (const contents of [
      'not json',
      '{}',
      '{"port":0,"token":"t"}',
      '{"port":"x","token":"t"}',
      '{"port":1,"token":""}'
    ]) {
      const root = endpointRoot(contents)
      await expect(
        readVoiceSpeakLaunchInjection({ clientOnline: () => true, userDataPath: root })
      ).resolves.toBeNull()
    }
  })
})

describe('voiceSpeakClientOnlineFrom', () => {
  it('reads the negotiated voice capability live through the returned gate', () => {
    let connected = false
    const online = voiceSpeakClientOnlineFrom({
      hasConnectedClientCapability: (capability) => connected && capability === 'voice.speak.v1'
    })
    expect(online()).toBe(false)
    connected = true
    expect(online()).toBe(true)
  })
})

describe('VOICE_SPEAK_PROMPT_APPEND', () => {
  it('teaches the speak tool with briefings over readouts, prose over lists', () => {
    expect(VOICE_SPEAK_PROMPT_APPEND).toContain('`speak`')
    expect(VOICE_SPEAK_PROMPT_APPEND).toContain('briefings over readouts, prose over lists')
  })
})

describe('VOICE_SPEAK_TOKEN_HEADER', () => {
  it('names the speak server token header', () => {
    expect(VOICE_SPEAK_TOKEN_HEADER).toBe('x-orca-speak-token')
  })
})

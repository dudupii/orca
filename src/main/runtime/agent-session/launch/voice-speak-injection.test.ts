import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SpeakMcpServer } from '../../../voice/speak-mcp-server'
import { readVoiceSpeakLaunchInjection, voiceSpeakClientOnlineFrom } from './voice-speak-injection'

const roots: string[] = []
const servers: SpeakMcpServer[] = []
const unrelated: Server[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const server of unrelated.splice(0)) {
    server.close()
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

/** A live speak server publishing into `root`, the way the host runtime starts one. */
async function liveSpeakEndpoint(root: string): Promise<{ port: number; token: string }> {
  const server = new SpeakMcpServer({ userDataPath: root, dispatch: () => {} })
  servers.push(server)
  await server.start()
  return JSON.parse(readFileSync(join(root, 'speak', 'speak-endpoint.json'), 'utf8'))
}

/** A loopback port that recently stopped listening: valid to write down, dead to probe. */
async function releasedLoopbackPort(): Promise<number> {
  const taken = createServer()
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture shaping; the stub exercises only the fields under test
  const { port } = taken.address() as { port: number }
  await new Promise<void>((resolve) => taken.close(() => resolve()))
  return port
}

async function unrelatedOkServer(): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('hello')
  })
  unrelated.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture shaping; the stub exercises only the fields under test
  return (server.address() as { port: number }).port
}

describe('readVoiceSpeakLaunchInjection', () => {
  it('resolves a live speak endpoint for a spawn while a voice-capable phone is connected', async () => {
    const root = endpointRoot(null)
    const live = await liveSpeakEndpoint(root)
    await expect(
      readVoiceSpeakLaunchInjection({ clientOnline: () => true, userDataPath: root })
    ).resolves.toEqual({
      serverUrl: `http://127.0.0.1:${live.port}/mcp`,
      token: live.token
    })
  })

  it('returns null while no voice-capable phone is connected, even with a live endpoint', async () => {
    const root = endpointRoot(null)
    await liveSpeakEndpoint(root)
    await expect(
      readVoiceSpeakLaunchInjection({ clientOnline: () => false, userDataPath: root })
    ).resolves.toBeNull()
  })

  it('returns null for a stale endpoint file a stopped speak server left behind', async () => {
    const root = endpointRoot(null)
    const server = new SpeakMcpServer({ userDataPath: root, dispatch: () => {} })
    await server.start()
    server.stop()
    await expect(
      readVoiceSpeakLaunchInjection({ clientOnline: () => true, userDataPath: root })
    ).resolves.toBeNull()
  })

  it('returns null for a valid file whose port no longer answers', async () => {
    const root = endpointRoot(
      `${JSON.stringify({ port: await releasedLoopbackPort(), token: 'token-1' })}\n`
    )
    await expect(
      readVoiceSpeakLaunchInjection({ clientOnline: () => true, userDataPath: root })
    ).resolves.toBeNull()
  })

  it('returns null when the live server rejects the file token as stale', async () => {
    const root = endpointRoot(null)
    const live = await liveSpeakEndpoint(root)
    // The server restarted and kept the port but rotated the token: the old file must not inject.
    const staleTokenRoot = endpointRoot(
      `${JSON.stringify({ port: live.port, token: 'previous-token' })}\n`
    )
    await expect(
      readVoiceSpeakLaunchInjection({ clientOnline: () => true, userDataPath: staleTokenRoot })
    ).resolves.toBeNull()
  })

  it('returns null when an unrelated loopback service answers on the file port', async () => {
    const root = endpointRoot(
      `${JSON.stringify({ port: await unrelatedOkServer(), token: 'token-1' })}\n`
    )
    await expect(
      readVoiceSpeakLaunchInjection({ clientOnline: () => true, userDataPath: root })
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

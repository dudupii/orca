import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { RuntimeMobileNotificationController } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import type { MobileNotificationDispatchEvent } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import { SpeakMcpServer, type SpeakBroadcastRequest } from './speak-mcp-server'

const userDataPath = mkdtempSync(join(tmpdir(), 'orca-speak-mcp-'))

afterAll(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function readPublishedEndpoint(): { port: number; token: string } {
  const endpoint = JSON.parse(
    readFileSync(join(userDataPath, 'speak', 'speak-endpoint.json'), 'utf8')
  )
  if (typeof endpoint.port !== 'number' || typeof endpoint.token !== 'string') {
    throw new Error('malformed speak endpoint file')
  }
  return endpoint
}

async function connectSpeakClient(): Promise<Client> {
  const { port, token } = readPublishedEndpoint()
  const client = new Client({ name: 'speak-test', version: '0.0.0-test' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
      requestInit: { headers: { 'x-orca-speak-token': token } }
    })
  )
  return client
}

describe('SpeakMcpServer', () => {
  it('rejects callers without the session token', async () => {
    const server = new SpeakMcpServer({ userDataPath, dispatch: () => {} })
    await server.start()
    try {
      const { port, token } = readPublishedEndpoint()
      const post = (tokenHeader?: string) =>
        fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(tokenHeader !== undefined ? { 'x-orca-speak-token': tokenHeader } : {})
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
        })
      expect((await post()).status).toBe(403)
      expect((await post(`wrong-${token}`)).status).toBe(403)
    } finally {
      server.stop()
    }
  })

  it('rejects unauthenticated callers before revealing method behavior', async () => {
    const server = new SpeakMcpServer({ userDataPath, dispatch: () => {} })
    await server.start()
    try {
      const { port } = readPublishedEndpoint()
      const get = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' })
      expect(get.status).toBe(403)
    } finally {
      server.stop()
    }
  })

  it('answers authenticated GET and DELETE with a 405 JSON-RPC response, not 404', async () => {
    const server = new SpeakMcpServer({ userDataPath, dispatch: () => {} })
    await server.start()
    try {
      const { port, token } = readPublishedEndpoint()
      const headers = { 'x-orca-speak-token': token }
      // No sessions exist to terminate and no standalone SSE stream is offered: the
      // stateless transport-compatible answer is 405 with Allow, never a session-less 404.
      const methodNotAllowed = {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null
      }
      const get = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', headers })
      expect(get.status).toBe(405)
      expect(get.headers.get('allow')).toBe('POST')
      expect(await get.json()).toEqual(methodNotAllowed)
      const del = await fetch(`http://127.0.0.1:${port}/`, { method: 'DELETE', headers })
      expect(del.status).toBe(405)
      expect(del.headers.get('allow')).toBe('POST')
      expect(await del.json()).toEqual(methodNotAllowed)
    } finally {
      server.stop()
    }
  })

  it('fails startup when the endpoint file cannot be published', async () => {
    // A regular file where the speak/ directory must go: every write path fails (ENOTDIR).
    const blockedPath = join(userDataPath, 'blocked-as-a-file')
    writeFileSync(blockedPath, '')
    const server = new SpeakMcpServer({ userDataPath: blockedPath, dispatch: () => {} })
    // The endpoint file is the discovery contract: an unpublished address+token is startup
    // failure, never a silently running server that voice.speak.v1 still advertises.
    await expect(server.start()).rejects.toThrow()
    // State must be reset, so a retried start() attempts a fresh bind instead of returning
    // early as an already-started server.
    await expect(server.start()).rejects.toThrow()
  })

  it('answers speak without waiting on any broadcast downstream', async () => {
    const spoken: SpeakBroadcastRequest[] = []
    const server = new SpeakMcpServer({
      userDataPath,
      dispatch: (request) => {
        spoken.push(request)
        // Phone delivery that never settles; the tool must still answer.
        void new Promise<never>(() => {})
      }
    })
    await server.start()
    const client = await connectSpeakClient()
    try {
      const result = await client.callTool({
        name: 'speak',
        arguments: {
          text: 'Deploy finished; all checks green.',
          lang: 'en-US',
          session: 'session-7'
        }
      })
      expect(result.isError).not.toBe(true)
      expect(spoken).toEqual([
        { text: 'Deploy finished; all checks green.', lang: 'en-US', session: 'session-7' }
      ])
    } finally {
      await client.close()
      server.stop()
    }
  })

  it('broadcasts a speak notification that is never journaled', async () => {
    const controller = new RuntimeMobileNotificationController()
    const dispatched: MobileNotificationDispatchEvent[] = []
    controller.onDispatched((event) => {
      if (event.type === 'notification') {
        dispatched.push(event)
      }
    })
    const server = new SpeakMcpServer({
      userDataPath,
      dispatch: (request) => controller.dispatchSpeak(request)
    })
    await server.start()
    const client = await connectSpeakClient()
    try {
      const result = await client.callTool({ name: 'speak', arguments: { text: 'Tests pass.' } })
      expect(result.isError).not.toBe(true)
      const [event] = dispatched
      expect(event?.source).toBe('speak')
      expect(event?.body).toBe('Tests pass.')
      // No structuredOrigin means no journal cursor, so attention reads can never retire it.
      expect(event && 'structuredOrigin' in event).toBe(false)
    } finally {
      await client.close()
      server.stop()
    }
  })
})

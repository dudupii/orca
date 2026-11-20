import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { reserveLoopbackPort } from '../orcad/browser-providers/electron/loopback-port-reservation'
import { writeSpeakEndpointFile } from './speak-endpoint-file'

const SPEAK_TOKEN_HEADER = 'x-orca-speak-token'

export type SpeakBroadcastRequest = {
  text: string
  lang?: string
  session?: string
}

/** Fire-and-forget contract: the tool never awaits phone, audio, or gateway state. */
export type SpeakBroadcastDispatch = (request: SpeakBroadcastRequest) => void

export type SpeakMcpServerOptions = {
  dispatch: SpeakBroadcastDispatch
  /** Endpoint file directory (port+token publication), mirroring agent-hooks. */
  userDataPath: string
}

/** Loopback HTTP MCP server exposing the model-authored speak tool as a broadcast. */
export class SpeakMcpServer {
  private readonly dispatch: SpeakBroadcastDispatch
  private readonly userDataPath: string
  private server: Server | null = null
  private port = 0
  private token = ''

  constructor(options: SpeakMcpServerOptions) {
    this.dispatch = options.dispatch
    this.userDataPath = options.userDataPath
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }
    this.token = randomUUID()
    const port = await reserveLoopbackPort()
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      const onStartupError = (error: Error): void => {
        server.removeListener('error', onStartupError)
        reject(error)
      }
      server.once('error', onStartupError)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onStartupError)
        server.on('error', (error) => console.error('[speak] server error', error))
        this.server = server
        this.port = port
        resolve()
      })
    })
    writeSpeakEndpointFile(this.userDataPath, { port: this.port, token: this.token })
  }

  stop(): void {
    // Leave the endpoint file: stale files fail closed at connect, and unlinking races another instance.
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.headers[SPEAK_TOKEN_HEADER] !== this.token) {
      res.writeHead(403)
      res.end()
      return
    }
    // Stateless per request: no session ids, plain JSON replies, nothing retained between calls.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    const server = buildSpeakMcpServer(this.dispatch)
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }
}

function buildSpeakMcpServer(dispatch: SpeakBroadcastDispatch): McpServer {
  const server = new McpServer({ name: 'orca-speak', version: '1.0.0' })
  server.registerTool(
    'speak',
    {
      description:
        "Read a short briefing aloud on the user's phone. Returns immediately and never waits for playback.",
      inputSchema: {
        text: z.string().min(1),
        lang: z.string().optional(),
        session: z.string().optional()
      }
    },
    ({ text, lang, session }) => {
      dispatch({
        text,
        ...(lang !== undefined ? { lang } : {}),
        ...(session !== undefined ? { session } : {})
      })
      return { content: [{ type: 'text', text: 'Speak broadcast queued.' }] }
    }
  )
  return server
}

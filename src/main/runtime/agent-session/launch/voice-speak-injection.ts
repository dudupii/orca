// Spawn-time voice.speak.v1 injection: when the launch of a structured session finds a
// voice-capable phone connected, resolve the loopback speak MCP endpoint once and hand it to
// the agent's launch part, which seals it into that spawn's tool set and prompt. The result is
// fixed at spawn by construction — the part reads this once, and nothing re-evaluates it while
// the session runs.

import { readFile } from 'node:fs/promises'
import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { VOICE_SPEAK_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/mobile-runtime-capabilities'
import { speakEndpointFilePath, type SpeakEndpoint } from '../../../voice/speak-endpoint-file'

/** Mirrors the speak server's private token header; the voice module keeps its own copy. */
export const VOICE_SPEAK_TOKEN_HEADER = 'x-orca-speak-token'

/** The speak server names itself in MCP initialize answers; a probe match proves identity. */
const SPEAK_SERVER_INFO_NAME = 'orca-speak'

/** A loopback answer slower than this is a dead endpoint for spawn purposes. */
const SPEAK_ENDPOINT_PROBE_TIMEOUT_MS = 2_000

/** What a launch part needs to point an agent at the speak MCP server. */
export type VoiceSpeakLaunchInjection = {
  /** Loopback speak MCP endpoint; the token travels in a header, never the URL. */
  serverUrl: string
  /** The token the speak endpoint requires on every request. */
  token: string
}

export type VoiceSpeakInjectionInput = {
  /** Whether any authenticated phone currently negotiates the voice capability. */
  clientOnline: () => boolean
  /** The speak endpoint file's root, the same userData path the speak server publishes to. */
  userDataPath: string
}

function voiceSpeakServerUrl(endpoint: SpeakEndpoint): string {
  return `http://127.0.0.1:${endpoint.port}/mcp`
}

function parseSpeakEndpoint(text: string): SpeakEndpoint | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const { port, token } = parsed as Record<string, unknown>
  return Number.isInteger(port) &&
    0 < (port as number) &&
    (port as number) < 65_536 &&
    typeof token === 'string' &&
    token.length > 0
    ? { port: port as number, token }
    : null
}

/** The initialize answer must come from this speak server, not any loopback 200. */
function isSpeakServerInitializeAnswer(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false
  }
  const { jsonrpc, result } = payload as Record<string, unknown>
  if (jsonrpc !== '2.0' || typeof result !== 'object' || result === null) {
    return false
  }
  const { protocolVersion, serverInfo } = result as Record<string, unknown>
  return (
    typeof protocolVersion === 'string' &&
    typeof serverInfo === 'object' &&
    serverInfo !== null &&
    (serverInfo as Record<string, unknown>).name === SPEAK_SERVER_INFO_NAME
  )
}

/**
 * The speak server deliberately leaves its endpoint file behind on stop, so a syntactically
 * valid file proves nothing: only an authenticated initialize this server answers proves the
 * endpoint is live before a spawn points a model at it.
 */
async function speakEndpointAnswers(endpoint: SpeakEndpoint): Promise<boolean> {
  try {
    const response = await fetch(voiceSpeakServerUrl(endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The streamable transport refuses clients that accept only one body kind.
        accept: 'application/json, text/event-stream',
        [VOICE_SPEAK_TOKEN_HEADER]: endpoint.token
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'orca-voice-speak-injection', version: '1.0.0' }
        }
      }),
      signal: AbortSignal.timeout(SPEAK_ENDPOINT_PROBE_TIMEOUT_MS)
    })
    if (!response.ok) {
      return false
    }
    return isSpeakServerInitializeAnswer(await response.json())
  } catch {
    // Refused, hung, or non-JSON answer: a stale, dead, or foreign endpoint reads as no capability.
    return false
  }
}

/**
 * The speak injection for one spawn, or null when voice is not negotiated. A missing,
 * unreadable, or stale endpoint file reads as no capability: the launch keeps today's shape
 * rather than pointing the model at a tool that cannot answer.
 */
export async function readVoiceSpeakLaunchInjection(
  input: VoiceSpeakInjectionInput
): Promise<VoiceSpeakLaunchInjection | null> {
  if (!input.clientOnline()) {
    return null
  }
  let text: string
  try {
    text = await readFile(speakEndpointFilePath(input.userDataPath), 'utf8')
  } catch {
    return null
  }
  const endpoint = parseSpeakEndpoint(text)
  if (!endpoint || !(await speakEndpointAnswers(endpoint))) {
    return null
  }
  return { serverUrl: voiceSpeakServerUrl(endpoint), token: endpoint.token }
}

/** A per-spawn resolver bound to one capability source and endpoint root. */
export function voiceSpeakLaunchResolver(
  input: VoiceSpeakInjectionInput
): () => Promise<VoiceSpeakLaunchInjection | null> {
  return () => readVoiceSpeakLaunchInjection(input)
}

/** The live voice.speak.v1 gate over an RPC server's connected phones. */
export function voiceSpeakClientOnlineFrom(capabilitySource: {
  hasConnectedClientCapability(capability: RuntimeCapability): boolean
}): () => boolean {
  return () => capabilitySource.hasConnectedClientCapability(VOICE_SPEAK_RUNTIME_CAPABILITY)
}

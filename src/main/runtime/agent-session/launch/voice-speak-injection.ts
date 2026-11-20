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

/**
 * The voice briefing style taught to agents whose spawn found a voice-capable phone. One
 * wording, kept beside the injection that carries it, so no launch path rewrites it.
 */
export const VOICE_SPEAK_PROMPT_APPEND =
  'A paired phone is listening: the `speak` tool reads a short briefing aloud there. ' +
  'Close meaningful work with one spoken briefing - briefings over readouts, prose over lists - ' +
  'and keep the written reply for the details. Speaking is optional: skip it when there is ' +
  'nothing worth hearing aloud.'

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

/**
 * The speak injection for one spawn, or null when voice is not negotiated. A missing or
 * unreadable endpoint file reads as no capability: the launch keeps today's shape rather than
 * pointing the model at a tool that cannot answer.
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
  return endpoint ? { serverUrl: voiceSpeakServerUrl(endpoint), token: endpoint.token } : null
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

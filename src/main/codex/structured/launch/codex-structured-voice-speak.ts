import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'
import { VOICE_SPEAK_TOKEN_HEADER } from '../../../runtime/agent-session/launch/voice-speak-injection'
import { voiceSpeakBriefingPromptAppend } from '../../../runtime/agent-session/prompts/voice-speak-briefing-prompt'

/**
 * Thread/start config keys that add the speak MCP server for a spawn that found a
 * voice-capable phone. Dotted keys mirror the other thread config overlays
 * (`sandbox_workspace_write.writable_roots`, `shell_environment_policy.set.*`).
 */
export function codexVoiceSpeakThreadConfig(
  injection: VoiceSpeakLaunchInjection
): Record<string, unknown> {
  return {
    'mcp_servers.speak.url': injection.serverUrl,
    [`mcp_servers.speak.http_headers.${VOICE_SPEAK_TOKEN_HEADER}`]: injection.token
  }
}

/** The effective developer_instructions the app-server reports for a working directory. */
function readReportedDeveloperInstructions(answer: unknown): string | null | undefined {
  if (typeof answer !== 'object' || answer === null) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowing an already runtime-checked unknown for property access
  const { config } = answer as Record<string, unknown>
  if (typeof config !== 'object' || config === null) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowing an already runtime-checked unknown for property access
  const { developer_instructions: reported } = config as Record<string, unknown>
  return typeof reported === 'string' ? reported : reported === null ? null : undefined
}

/**
 * The developer instructions one voice-capable spawn seals. Codex's developer-instruction
 * carriers — the config overlay key as much as the thread-level `developerInstructions`
 * parameter — replace the effective value rather than append to it, so the sealed value
 * carries the user's existing instructions with the voice briefing appended — the briefing
 * naming the spawn's session id, so every `speak` call the model makes carries it. When the
 * effective instructions cannot be read, the seal is null: the spawn keeps the speak tool
 * without a prompt override rather than risk discarding the user's instructions.
 */
export async function sealCodexVoiceSpeakInstructions(
  connection: Pick<CodexAppServerConnection, 'request'>,
  input: { cwd: string; sessionId: string; timeoutMs?: number }
): Promise<{ developerInstructions: string } | null> {
  let reported: string | null | undefined
  try {
    const answer = await connection.request(
      'config/read',
      { cwd: input.cwd },
      input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : undefined
    )
    reported = readReportedDeveloperInstructions(answer)
  } catch {
    return null
  }
  if (reported === undefined) {
    return null
  }
  const briefing = voiceSpeakBriefingPromptAppend(input.sessionId)
  return {
    developerInstructions: reported ? `${reported}\n\n${briefing}` : briefing
  }
}

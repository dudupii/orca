import type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'
import {
  VOICE_SPEAK_PROMPT_APPEND,
  VOICE_SPEAK_TOKEN_HEADER
} from '../../../runtime/agent-session/launch/voice-speak-injection'

/**
 * Thread/start config keys that add the speak MCP server and the voice briefing style for a
 * spawn that found a voice-capable phone. Dotted keys mirror the other thread config overlays
 * (`sandbox_workspace_write.writable_roots`, `shell_environment_policy.set.*`).
 */
export function codexVoiceSpeakThreadConfig(
  injection: VoiceSpeakLaunchInjection
): Record<string, unknown> {
  return {
    'mcp_servers.speak.url': injection.serverUrl,
    [`mcp_servers.speak.http_headers.${VOICE_SPEAK_TOKEN_HEADER}`]: injection.token,
    developer_instructions: VOICE_SPEAK_PROMPT_APPEND
  }
}

import type { McpServer } from '../generated/acp-protocol.generated'
import type { VoiceSpeakLaunchInjection } from '../../runtime/agent-session/launch/voice-speak-injection'
import { VOICE_SPEAK_TOKEN_HEADER } from '../../runtime/agent-session/launch/voice-speak-injection'

/**
 * The session/new MCP server list for a spawn that found a voice-capable phone. ACP's
 * session/new has no prompt carrier, so the injection adds the tool only.
 */
export function acpVoiceSpeakMcpServers(injection: VoiceSpeakLaunchInjection): McpServer[] {
  return [
    {
      type: 'http',
      name: 'speak',
      url: injection.serverUrl,
      headers: [{ name: VOICE_SPEAK_TOKEN_HEADER, value: injection.token }]
    }
  ]
}

import type { Options as ClaudeAgentSdkOptions } from '@anthropic-ai/claude-agent-sdk'
import type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'
import {
  VOICE_SPEAK_PROMPT_APPEND,
  VOICE_SPEAK_TOKEN_HEADER
} from '../../../runtime/agent-session/launch/voice-speak-injection'

export type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'

/**
 * SDK option overrides for a spawn that found a voice-capable phone: the speak MCP server and
 * the voice briefing style appended to the preset system prompt. The SDK snapshots the system
 * prompt on first use, so the append stays fixed at spawn.
 */
export function claudeVoiceSpeakOptions(
  injection: VoiceSpeakLaunchInjection
): Pick<ClaudeAgentSdkOptions, 'mcpServers' | 'systemPrompt'> {
  return {
    mcpServers: {
      speak: {
        type: 'http',
        url: injection.serverUrl,
        headers: { [VOICE_SPEAK_TOKEN_HEADER]: injection.token }
      }
    },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: VOICE_SPEAK_PROMPT_APPEND }
  }
}

import type { Options as ClaudeAgentSdkOptions } from '@anthropic-ai/claude-agent-sdk'
import type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'
import { VOICE_SPEAK_TOKEN_HEADER } from '../../../runtime/agent-session/launch/voice-speak-injection'
import { voiceSpeakBriefingPromptAppend } from '../../../runtime/agent-session/prompts/voice-speak-briefing-prompt'

export type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'

/**
 * SDK option overrides for a spawn that found a voice-capable phone: the speak MCP server and
 * the voice briefing appended to the preset system prompt, the briefing naming the spawn's
 * session id so every `speak` call the model makes carries it. The SDK snapshots the system
 * prompt on first use, so the append stays fixed at spawn.
 */
export function claudeVoiceSpeakOptions(
  injection: VoiceSpeakLaunchInjection,
  sessionId: string
): Pick<ClaudeAgentSdkOptions, 'mcpServers' | 'systemPrompt'> {
  return {
    mcpServers: {
      speak: {
        type: 'http',
        url: injection.serverUrl,
        headers: { [VOICE_SPEAK_TOKEN_HEADER]: injection.token }
      }
    },
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: voiceSpeakBriefingPromptAppend(sessionId)
    }
  }
}

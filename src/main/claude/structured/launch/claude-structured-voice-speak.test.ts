import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { createClaudeStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'
import { VOICE_SPEAK_BRIEFING_PROMPT_APPEND } from '../../../runtime/agent-session/prompts/voice-speak-briefing-prompt'

const SESSION_ID = 'session-voice-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createClaudeStructuredLaunchResolver>
>[0]['identity']

const INJECTION: VoiceSpeakLaunchInjection = {
  serverUrl: 'http://127.0.0.1:45123/mcp',
  token: 'token-1'
}

function resolverDeps(voiceDeps: {
  resolveVoiceSpeak?: () => Promise<VoiceSpeakLaunchInjection | null>
}) {
  return {
    store: {
      getRecord: () =>
        agentSessionRecordFixture({
          sessionId: SESSION_ID,
          provider: 'claude',
          location: { workspaceKind: 'git-worktree' }
        }),
      pinLaunchDirectory: vi.fn()
    },
    resolveCommand: () => ({ command: '/opt/bin/claude', prefixArgs: [] }),
    resolveLaunchArgs: () => [],
    resolveAuthPolicy: () => ({ account: 'system' as const }),
    resolveInheritedEnv: async () => ({}),
    hasTranscript: async () => false,
    ...voiceDeps
  }
}

describe('claude structured launch: voice.speak.v1 injection', () => {
  it('gives the spawn the speak MCP server and the prompt-suffixed system prompt', async () => {
    const launch = await createClaudeStructuredLaunchResolver(
      resolverDeps({ resolveVoiceSpeak: async () => INJECTION })
    )({ identity: IDENTITY })
    expect(launch.options.mcpServers).toEqual({
      speak: {
        type: 'http',
        url: INJECTION.serverUrl,
        headers: { 'x-orca-speak-token': INJECTION.token }
      }
    })
    expect(launch.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: VOICE_SPEAK_BRIEFING_PROMPT_APPEND
    })
  })

  it('keeps the no-capability spawn byte-identical: a null injection changes nothing exactly', async () => {
    const withoutDep = await createClaudeStructuredLaunchResolver(resolverDeps({}))({
      identity: IDENTITY
    })
    const withNullDep = await createClaudeStructuredLaunchResolver(
      resolverDeps({ resolveVoiceSpeak: async () => null })
    )({ identity: IDENTITY })
    expect(JSON.stringify(withNullDep)).toBe(JSON.stringify(withoutDep))
    expect(withNullDep.options.mcpServers).toBeUndefined()
    expect(withNullDep.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
  })

  it('fixes the injection at spawn: capability flips never reach a resolved launch', async () => {
    let online = true
    const resolver = createClaudeStructuredLaunchResolver(
      resolverDeps({ resolveVoiceSpeak: async () => (online ? INJECTION : null) })
    )
    const spoken = await resolver({ identity: IDENTITY })
    expect(spoken.options.mcpServers).toBeDefined()
    online = false
    expect(spoken.options.mcpServers).toBeDefined()
    const silent = await resolver({ identity: IDENTITY })
    expect(silent.options.mcpServers).toBeUndefined()
    expect(silent.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
  })
})

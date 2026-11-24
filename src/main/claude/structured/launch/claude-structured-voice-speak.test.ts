import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { createClaudeStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'

const SESSION_ID = 'session-voice-1'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture shaping; the stub exercises only the fields under test
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createClaudeStructuredLaunchResolver>
>[0]['identity']
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture shaping; the stub exercises only the fields under test
const identityFor = (sessionId: string): typeof IDENTITY => ({ sessionId }) as typeof IDENTITY

const INJECTION: VoiceSpeakLaunchInjection = {
  serverUrl: 'http://127.0.0.1:45123/mcp',
  token: 'token-1'
}

/**
 * The exact briefings these tests expect a voice-capable spawn to append, hardcoded in full
 * rather than rebuilt through the builder they judge: a builder that drops the session
 * sentence, interpolates the wrong session id, or drifts on wording fails against these
 * literals instead of moving the expectations with it.
 */
const OWN_SESSION_BRIEFING =
  'A paired phone is listening: the `speak` tool reads a short briefing aloud there. Close ' +
  'meaningful work with one spoken briefing - briefings over readouts, prose over lists - and ' +
  'keep the written reply for the details. A briefing is spoken prose: plain sentences, no ' +
  'markdown, no URLs, at most three sentences. Speaking is optional: skip it when there is ' +
  "nothing worth hearing aloud. This conversation's session id is session-voice-1: pass it as " +
  'the session argument on every `speak` call so the briefing plays only here.'
const OTHER_SESSION_BRIEFING =
  'A paired phone is listening: the `speak` tool reads a short briefing aloud there. Close ' +
  'meaningful work with one spoken briefing - briefings over readouts, prose over lists - and ' +
  'keep the written reply for the details. A briefing is spoken prose: plain sentences, no ' +
  'markdown, no URLs, at most three sentences. Speaking is optional: skip it when there is ' +
  "nothing worth hearing aloud. This conversation's session id is session-voice-2: pass it as " +
  'the session argument on every `speak` call so the briefing plays only here.'

function resolverDeps(
  voiceDeps: {
    resolveVoiceSpeak?: () => Promise<VoiceSpeakLaunchInjection | null>
  },
  sessionId: string = SESSION_ID
) {
  return {
    store: {
      getRecord: () =>
        agentSessionRecordFixture({
          sessionId,
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
      append: OWN_SESSION_BRIEFING
    })
  })

  it('appends a briefing that names the identity of the spawn, not another session', async () => {
    const other = 'session-voice-2'
    const spoken = await createClaudeStructuredLaunchResolver(
      resolverDeps({ resolveVoiceSpeak: async () => INJECTION }, other)
    )({ identity: identityFor(other) })
    expect(spoken.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: OTHER_SESSION_BRIEFING
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

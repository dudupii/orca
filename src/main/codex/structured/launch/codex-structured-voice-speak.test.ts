import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { createCodexStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'
import { VOICE_SPEAK_PROMPT_APPEND } from '../../../runtime/agent-session/launch/voice-speak-injection'
import { codexVoiceSpeakThreadConfig } from './codex-structured-voice-speak'
import { openCodexThread } from '../threads/codex-structured-thread-open'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'

const SESSION_ID = 'session-voice-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createCodexStructuredLaunchResolver>
>[0]['identity']

const INJECTION: VoiceSpeakLaunchInjection = {
  serverUrl: 'http://127.0.0.1:45123/mcp',
  token: 'token-1'
}

function record(): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId: SESSION_ID,
    provider: 'codex',
    location: { workspaceKind: 'git-worktree' },
    accountHome: { variable: 'CODEX_HOME', path: '/home/work/.codex' },
    providerHandleChain: []
  })
}

function resolverDeps(voiceDeps: {
  resolveVoiceSpeak?: () => Promise<VoiceSpeakLaunchInjection | null>
}) {
  return {
    store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
    resolveCommand: () => ({ command: '/usr/local/bin/codex', prefixArgs: [] }),
    resolveLaunchArgs: () => [],
    ...voiceDeps
  }
}

describe('codex structured launch: voice.speak.v1 injection', () => {
  it('seals the speak endpoint into a spawn whose phone negotiates the capability', async () => {
    const launch = await createCodexStructuredLaunchResolver(
      resolverDeps({ resolveVoiceSpeak: async () => INJECTION })
    )({ identity: IDENTITY })
    expect(launch.voiceSpeak).toEqual(INJECTION)
  })

  it('adds the speak MCP server and prompt suffix to the thread the spawn opens', async () => {
    const requests: { method: string; params: Record<string, unknown> }[] = []
    const connection = {
      request: async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params: params ?? {} })
        return { threadId: 'thread-1' }
      }
    }
    await openCodexThread(
      connection,
      { cwd: '/workspace/project', resumeThreadId: null, voiceSpeak: INJECTION },
      null
    )
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('thread/start')
    expect(requests[0].params.config).toMatchObject(codexVoiceSpeakThreadConfig(INJECTION))
    expect(requests[0].params.config).toEqual({
      'mcp_servers.speak.url': INJECTION.serverUrl,
      'mcp_servers.speak.http_headers.x-orca-speak-token': INJECTION.token,
      developer_instructions: VOICE_SPEAK_PROMPT_APPEND
    })
  })

  it('keeps the no-capability spawn byte-identical: a null injection changes nothing exactly', async () => {
    const withoutDep = await createCodexStructuredLaunchResolver(resolverDeps({}))({
      identity: IDENTITY
    })
    const withNullDep = await createCodexStructuredLaunchResolver(
      resolverDeps({ resolveVoiceSpeak: async () => null })
    )({ identity: IDENTITY })
    expect(JSON.stringify(withNullDep)).toBe(JSON.stringify(withoutDep))
    expect(withNullDep.voiceSpeak).toBeUndefined()
  })

  it('fixes the injection at spawn: capability flips never reach a resolved launch', async () => {
    let online = true
    const resolver = createCodexStructuredLaunchResolver(
      resolverDeps({
        resolveVoiceSpeak: async () => (online ? INJECTION : null)
      })
    )
    const spoken = await resolver({ identity: IDENTITY })
    expect(spoken.voiceSpeak).toEqual(INJECTION)
    online = false
    expect(JSON.stringify(spoken)).toContain('token-1')
    const silent = await resolver({ identity: IDENTITY })
    expect(silent.voiceSpeak).toBeUndefined()
    // A phone arriving after a spawn does not retrofit that session either.
    const beforeArrival = await resolver({ identity: IDENTITY })
    expect(beforeArrival.voiceSpeak).toBeUndefined()
    online = true
    expect(beforeArrival.voiceSpeak).toBeUndefined()
    const afterArrival = await resolver({ identity: IDENTITY })
    expect(afterArrival.voiceSpeak).toEqual(INJECTION)
  })
})

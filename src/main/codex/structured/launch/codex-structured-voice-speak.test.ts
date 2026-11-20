import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { createCodexStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'
import { VOICE_SPEAK_BRIEFING_PROMPT_APPEND } from '../../../runtime/agent-session/prompts/voice-speak-briefing-prompt'
import {
  codexVoiceSpeakThreadConfig,
  sealCodexVoiceSpeakInstructions
} from './codex-structured-voice-speak'
import { openCodexThread } from '../threads/codex-structured-thread-open'
import { startCodexTurn } from '../turns/codex-structured-turn-start'
import { optionSession } from '../catalog/codex-structured-option-session.test-fixture'
import { USER_MESSAGE } from '../session-lifecycle/codex-structured-session-adapter-fixture'
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

/** A connection that answers config/read with `developerInstructions` and records every request. */
function sealingConnection(developerInstructions: string | null | { error: true }): {
  connection: Pick<CodexAppServerConnection, 'request'>
  requests: { method: string; params: Record<string, unknown> }[]
} {
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const request = async (method: string, params?: Record<string, unknown>) => {
    requests.push({ method, params: params ?? {} })
    if (method === 'config/read') {
      if (developerInstructions !== null && typeof developerInstructions === 'object') {
        throw new Error('unsupported method')
      }
      return { config: { developer_instructions: developerInstructions } }
    }
    return { threadId: 'thread-1', thread: {} }
  }
  return { connection: { request }, requests }
}

async function openVoiceSpeakThread(connection: Pick<CodexAppServerConnection, 'request'>) {
  const seal = await sealCodexVoiceSpeakInstructions(connection, { cwd: '/workspace/project' })
  expect(seal).not.toBeNull()
  await openCodexThread(
    connection,
    {
      cwd: '/workspace/project',
      resumeThreadId: null,
      voiceSpeak: INJECTION,
      ...(seal ? { developerInstructions: seal.developerInstructions } : {})
    },
    null
  )
  return seal
}

describe('codex structured launch: voice.speak.v1 injection', () => {
  it('seals the speak endpoint into a spawn whose phone negotiates the capability', async () => {
    const launch = await createCodexStructuredLaunchResolver(
      resolverDeps({ resolveVoiceSpeak: async () => INJECTION })
    )({ identity: IDENTITY })
    expect(launch.voiceSpeak).toEqual(INJECTION)
  })

  it('adds the speak MCP server and sealed developer instructions to the thread the spawn opens', async () => {
    const { connection, requests } = sealingConnection(null)
    const seal = await openVoiceSpeakThread(connection)
    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe('config/read')
    expect(requests[0].params).toEqual({ cwd: '/workspace/project' })
    expect(requests[1].method).toBe('thread/start')
    // The tool half rides the config overlay; the prompt half rides the thread-level carrier.
    expect(requests[1].params.config).toEqual(codexVoiceSpeakThreadConfig(INJECTION))
    expect(requests[1].params.config).not.toHaveProperty('developer_instructions')
    expect(requests[1].params.developerInstructions).toBe(seal?.developerInstructions)
    expect(seal?.developerInstructions).toBe(VOICE_SPEAK_BRIEFING_PROMPT_APPEND)
  })

  it('preserves the user effective developer instructions under the appended briefing', async () => {
    const { connection, requests } = sealingConnection('Keep answers terse.')
    const seal = await openVoiceSpeakThread(connection)
    expect(requests[1].params.developerInstructions).toBe(
      `Keep answers terse.\n\n${VOICE_SPEAK_BRIEFING_PROMPT_APPEND}`
    )
    expect(seal?.developerInstructions).toContain('Keep answers terse.')
  })

  it('injects the tool without a prompt override when the effective instructions cannot be read', async () => {
    const { connection, requests } = sealingConnection({ error: true })
    const seal = await sealCodexVoiceSpeakInstructions(connection, { cwd: '/workspace/project' })
    expect(seal).toBeNull()
    await openCodexThread(
      connection,
      { cwd: '/workspace/project', resumeThreadId: null, voiceSpeak: INJECTION },
      null
    )
    const start = requests.find(({ method }) => method === 'thread/start')
    expect(start?.params.config).toEqual(codexVoiceSpeakThreadConfig(INJECTION))
    expect(start?.params).not.toHaveProperty('developerInstructions')
  })

  it('keeps the sealed briefing effective on the turn that follows thread/start', async () => {
    const { connection, requests } = sealingConnection('Keep answers terse.')
    const seal = await openVoiceSpeakThread(connection)
    const session = {
      ...optionSession(connection.request),
      ...(seal ? { sealedDeveloperInstructions: seal.developerInstructions } : {})
    }
    session.activeTurnIds = new Set()
    await startCodexTurn(session, { clientMessageId: 'voice-1', body: USER_MESSAGE })
    const turn = requests.find(({ method }) => method === 'turn/start')
    expect(turn).toBeDefined()
    // collaborationMode takes precedence over developer instructions, and its null selects the
    // mode's built-in ones; the sealed value must ride every turn or the first one drops it.
    expect(turn?.params.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-live',
        reasoning_effort: 'high',
        developer_instructions: seal?.developerInstructions
      }
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

import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../native-chat/testing/agent-session-record-test-fixture'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { createAcpStructuredLaunchResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { VoiceSpeakLaunchInjection } from '../../runtime/agent-session/launch/voice-speak-injection'
import { acpLaunchSpecFor } from './acp-launch-registry'

const GROK = acpLaunchSpecFor('grok')!
const SESSION_ID = 'session-voice-1'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture shaping; the stub exercises only the fields under test
const IDENTITY = { sessionId: SESSION_ID } as AgentSessionJournalIdentity

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
          provider: 'grok',
          location: { workspaceKind: 'git-worktree' },
          accountHome: { variable: 'GROK_HOME', path: '/home/work/.grok' }
        }),
      pinLaunchDirectory: vi.fn()
    },
    resolveCommand: () => '/opt/bin/grok',
    savedSession: { hasProviderTurn: async () => false },
    ...voiceDeps
  }
}

describe('ACP structured launch: voice.speak.v1 injection', () => {
  it('seals the speak endpoint into a spawn whose phone negotiates the capability', async () => {
    const launch = await createAcpStructuredLaunchResolver(
      GROK,
      resolverDeps({ resolveVoiceSpeak: async () => INJECTION })
    )({ identity: IDENTITY })
    expect(launch.voiceSpeak).toEqual(INJECTION)
  })

  it('keeps the no-capability spawn byte-identical: a null injection changes nothing exactly', async () => {
    const withoutDep = await createAcpStructuredLaunchResolver(
      GROK,
      resolverDeps({})
    )({
      identity: IDENTITY
    })
    const withNullDep = await createAcpStructuredLaunchResolver(
      GROK,
      resolverDeps({ resolveVoiceSpeak: async () => null })
    )({ identity: IDENTITY })
    expect(JSON.stringify(withNullDep)).toBe(JSON.stringify(withoutDep))
    expect(withNullDep.voiceSpeak).toBeUndefined()
  })

  it('fixes the injection at spawn: capability flips never reach a resolved launch', async () => {
    let online = true
    const resolver = createAcpStructuredLaunchResolver(
      GROK,
      resolverDeps({ resolveVoiceSpeak: async () => (online ? INJECTION : null) })
    )
    const spoken = await resolver({ identity: IDENTITY })
    expect(spoken.voiceSpeak).toEqual(INJECTION)
    online = false
    expect(spoken.voiceSpeak).toEqual(INJECTION)
    const silent = await resolver({ identity: IDENTITY })
    expect(silent.voiceSpeak).toBeUndefined()
  })
})

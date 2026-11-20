import { afterEach, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpAdapterRig } from '../testing/acp-structured-adapter.test-support'
import type { VoiceSpeakLaunchInjection } from '../../../runtime/agent-session/launch/voice-speak-injection'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const INJECTION: VoiceSpeakLaunchInjection = {
  serverUrl: 'http://127.0.0.1:45123/mcp',
  token: 'token-1'
}

it('opens a new ACP session with the speak MCP server a spawn sealed in', async () => {
  const rig = await openAcpAdapterRig({ launch: { voiceSpeak: INJECTION } })
  await rig.acquire()
  const started = await rig.frame('session/new')
  expect((started.params as { mcpServers: unknown }).mcpServers).toEqual([
    {
      type: 'http',
      name: 'speak',
      url: INJECTION.serverUrl,
      headers: [{ name: 'x-orca-speak-token', value: INJECTION.token }]
    }
  ])
})

it('opens a new ACP session with no MCP server when the spawn found no voice phone', async () => {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  const started = await rig.frame('session/new')
  expect((started.params as { mcpServers: unknown }).mcpServers).toEqual([])
})

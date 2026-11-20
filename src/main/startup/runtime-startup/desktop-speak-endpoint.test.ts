import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-environment'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { readVoiceSpeakLaunchInjection } from '../../runtime/agent-session/launch/voice-speak-injection'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'
import { installDesktopVoiceSpeak } from './desktop-speak-endpoint'

const userDataPath = mkdtempSync(join(tmpdir(), 'orca-desktop-speak-endpoint-'))
const willQuitHandlers: (() => void)[] = []

setAppEnvironment({
  getPath: () => userDataPath,
  getAppPath: () => userDataPath,
  getVersion: () => '0.0.0-test',
  isPackaged: () => true,
  onWillQuit: (handler) => willQuitHandlers.push(handler),
  exit: () => {},
  getAppMetrics: () => []
})

afterAll(() => {
  for (const handler of willQuitHandlers.splice(0)) {
    handler()
  }
  rmSync(userDataPath, { recursive: true, force: true })
})

/** The desktop runtime and RPC server shapes the voice wiring consumes. */
function desktopVoiceFixture(): {
  runtime: OrcaRuntimeService
  runtimeRpc: OrcaRuntimeRpcServer
  setPhoneCapability: (connected: boolean) => void
} {
  let phoneConnected = false
  return {
    runtime: {
      setVoiceSpeakClientOnline: () => {},
      dispatchSpeakNotification: () => {}
    } as unknown as OrcaRuntimeService,
    runtimeRpc: {
      hasConnectedClientCapability: (capability: string) =>
        phoneConnected && capability === 'voice.speak.v1'
    } as unknown as OrcaRuntimeRpcServer,
    setPhoneCapability: (connected) => {
      phoneConnected = connected
    }
  }
}

/** The endpoint publishes asynchronously; the injection's live probe proves readiness. */
async function waitForInjection(clientOnline: () => boolean) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const injection = await readVoiceSpeakLaunchInjection({
      clientOnline,
      userDataPath: getProfileUserDataPath()
    })
    if (injection || Date.now() > deadline) {
      return injection
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

it('starts a live speak endpoint a desktop voice-capable spawn injects from the same root', async () => {
  const { runtime, runtimeRpc, setPhoneCapability } = desktopVoiceFixture()
  installDesktopVoiceSpeak(runtime, runtimeRpc)
  setPhoneCapability(true)
  const injection = await waitForInjection(() => true)
  // A desktop spawn while a voice-capable phone is connected finds a live speak endpoint.
  expect(injection).not.toBeNull()
  expect(injection?.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  expect(typeof injection?.token).toBe('string')
  // The same published endpoint reads as no capability while no voice phone is connected.
  setPhoneCapability(false)
  expect(await waitForInjection(() => false)).toBeNull()
})

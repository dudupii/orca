import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { startOrcadSpeakEndpoint } from '../../orcad/host-runtime/orcad-speak-endpoint'
import { voiceSpeakClientOnlineFrom } from '../../runtime/agent-session/launch/voice-speak-injection'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'

/**
 * Wire the desktop runtime's voice.speak.v1 path: the negotiated-capability gate over its RPC
 * server's phones, and the loopback speak MCP endpoint the headless backend also starts,
 * publishing at the profile userData root structured-session spawn injection reads. The gate
 * without a live endpoint would leave every voice-capable desktop spawn with no speak tool or
 * a stale file's dead address.
 */
export function installDesktopVoiceSpeak(
  runtime: OrcaRuntimeService,
  runtimeRpc: OrcaRuntimeRpcServer
): void {
  runtime.setVoiceSpeakClientOnline(voiceSpeakClientOnlineFrom(runtimeRpc))
  startOrcadSpeakEndpoint(runtime, getProfileUserDataPath())
}

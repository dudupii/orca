import { getAppEnvironment } from '../../../shared/app-environment'
import { SpeakMcpServer } from '../../voice/speak-mcp-server'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

/** The model authors spoken briefings on this loopback MCP endpoint; they leave as phone broadcasts. */
export function startOrcadSpeakEndpoint(runtime: OrcaRuntimeService, userDataPath: string): void {
  const server = new SpeakMcpServer({
    userDataPath,
    dispatch: (request) => runtime.dispatchSpeakNotification(request)
  })
  server.start().catch((error: unknown) => {
    console.error('[speak] endpoint startup failed', error)
  })
  getAppEnvironment().onWillQuit(() => server.stop())
}

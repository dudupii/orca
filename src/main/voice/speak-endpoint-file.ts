import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type SpeakEndpoint = {
  port: number
  token: string
}

export function speakEndpointFilePath(userDataPath: string): string {
  return join(userDataPath, 'speak', 'speak-endpoint.json')
}

/** Atomically publish the loopback address and token, the way agent-hooks publishes its own. */
export function writeSpeakEndpointFile(userDataPath: string, endpoint: SpeakEndpoint): boolean {
  const endpointDir = join(userDataPath, 'speak')
  const finalPath = speakEndpointFilePath(userDataPath)
  const tmpPath = join(endpointDir, `.speak-endpoint-${process.pid}-${randomUUID()}.tmp`)
  let tmpWritten = false
  try {
    // Owner-only everywhere: the file carries the loopback auth token.
    mkdirSync(endpointDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      // Creation mode does not repair existing directories; chmod them on POSIX.
      try {
        chmodSync(endpointDir, 0o700)
      } catch {
        // best-effort
      }
    }
    writeFileSync(tmpPath, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 })
    tmpWritten = true
    renameSync(tmpPath, finalPath)
    return true
  } catch (error) {
    console.error('[speak] failed to write endpoint file:', error)
    if (tmpWritten) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp may already be gone
      }
    }
    return false
  }
}

import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MOBILE_DICTATION_CLIENT_REPLACED_ERROR_MESSAGE } from './mobile-dictation-phase-watchdog'
import type { MobileDictationRun } from './mobile-dictation-engine-run'
import { failActiveMobileDictation } from './mobile-dictation-retry'
import type { DictationStatus } from './mobile-dictation-session-state'

type UseMobileDictationClientReplacedOptions = {
  client: RpcClient | null
  // The client the underway run was fenced to, committed one render behind the prop.
  committedClient: RefObject<RpcClient | null>
  status: RefObject<DictationStatus>
  activeId: RefObject<string | null>
  run: RefObject<MobileDictationRun | null>
  abandon: () => Promise<void>
}

// One hook serves every session, so a replaced client ends what the old one heard: the replacement
// host never received the run, and Retry replays its recording there.
export function useMobileDictationClientReplaced(
  options: UseMobileDictationClientReplacedOptions
): void {
  const { client, committedClient, status, activeId, run, abandon } = options
  useLayoutEffect(() => {
    // A run cannot outlive the client it was started on: the replacement host never heard its dictation.
    if (client !== committedClient.current && run.current) {
      const dictationId = activeId.current
      if (dictationId !== null) {
        failActiveMobileDictation(
          run.current,
          dictationId,
          new Error(MOBILE_DICTATION_CLIENT_REPLACED_ERROR_MESSAGE)
        )
      } else if (status.current === 'starting') {
        // A start still opening its microphone was fenced to the replaced client: its late open
        // would send the start there while later audio reads the replacement. Abandon it now, so
        // the press recovers on the replacement client instead of splitting the run across hosts.
        void abandon()
      }
    }
    committedClient.current = client
  }, [abandon, activeId, client, committedClient, run, status])
}

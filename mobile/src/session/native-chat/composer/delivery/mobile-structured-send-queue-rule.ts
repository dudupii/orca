import { selectAgentSessionCurrentRequests } from '../../../../../../src/shared/agent-session/requests/agent-session-current-requests'
import type { StructuredAgentSessionState } from '../../../../../../src/shared/agent-session/structured-agent-session-reducer'
import {
  structuredAgentSessionFollowUpsQueue,
  structuredAgentSessionQueueEnabled
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-queued-cards'

/** The desktop's rule: the alternate flips the setting first, then the queue's own rules decide. */
export function mobileStructuredSendQueues(
  queueCapable: boolean,
  queueFollowUps: boolean,
  state: Pick<StructuredAgentSessionState, 'items' | 'currentRequests' | 'queuedMessages'>,
  send: { alternate?: boolean; isWorking: boolean; stopping: boolean } = {
    isWorking: false,
    stopping: false
  }
): boolean {
  return (
    queueCapable &&
    structuredAgentSessionQueueEnabled(
      structuredAgentSessionFollowUpsQueue(queueFollowUps, send),
      state,
      selectAgentSessionCurrentRequests(state)
    )
  )
}

/** One send's `delivery`: `queue-if-active` waits behind the running turn; undefined steers the message into it. */
export function mobileStructuredSendDeliveryMode(
  queueCapable: boolean,
  queueFollowUps: boolean,
  state: Pick<StructuredAgentSessionState, 'items' | 'currentRequests' | 'queuedMessages'>,
  send: { alternate?: boolean; steer?: boolean; isWorking: boolean; stopping: boolean }
): 'queue-if-active' | undefined {
  // A steering injection reroutes the running turn ahead of every waiting card, so it never queues.
  if (send.steer) {
    return undefined
  }
  return mobileStructuredSendQueues(queueCapable, queueFollowUps, state, send)
    ? 'queue-if-active'
    : undefined
}

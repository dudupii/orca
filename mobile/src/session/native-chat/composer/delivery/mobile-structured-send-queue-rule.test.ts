import { describe, expect, it } from 'vitest'

import type { AgentSessionQueuedMessage } from '../../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import {
  mobileStructuredSendDeliveryMode,
  mobileStructuredSendQueues
} from './mobile-structured-send-queue-rule'

type QueueRuleState = Parameters<typeof mobileStructuredSendQueues>[2]

const idleChat: QueueRuleState = { items: [], currentRequests: [], queuedMessages: [] }

function chatWithWaitingCommandCard(paused?: true): QueueRuleState {
  const card: AgentSessionQueuedMessage = {
    messageId: 'queued-compact',
    position: 0,
    body: { kind: 'message', role: 'user', blocks: [], command: { name: 'compact' } },
    state: 'waiting',
    ...(paused ? { paused } : {})
  }
  return { items: [], currentRequests: [], queuedMessages: [card] }
}

describe('mobileStructuredSendDeliveryMode', () => {
  it('queues behind the running turn while the follow-ups setting is on', () => {
    expect(
      mobileStructuredSendDeliveryMode(true, true, idleChat, { isWorking: true, stopping: false })
    ).toBe('queue-if-active')
  })

  it('keeps attaching queue-if-active with the setting on even while idle', () => {
    expect(
      mobileStructuredSendDeliveryMode(true, true, idleChat, { isWorking: false, stopping: false })
    ).toBe('queue-if-active')
  })

  it('never queues a send the host cannot queue, whatever the setting says', () => {
    expect(
      mobileStructuredSendDeliveryMode(false, true, idleChat, { isWorking: true, stopping: false })
    ).toBeUndefined()
  })

  it('sends into the turn with the setting off and no card waiting, working or not', () => {
    expect(
      mobileStructuredSendDeliveryMode(true, false, idleChat, { isWorking: true, stopping: false })
    ).toBeUndefined()
    expect(
      mobileStructuredSendDeliveryMode(true, false, idleChat, { isWorking: false, stopping: false })
    ).toBeUndefined()
  })

  it('flips the setting for an alternate send while the agent works and no Stop ends the turn', () => {
    expect(
      mobileStructuredSendDeliveryMode(true, false, idleChat, {
        alternate: true,
        isWorking: true,
        stopping: false
      })
    ).toBe('queue-if-active')
  })

  it('leaves an alternate unflipped while idle or stopping, so it sends into the turn', () => {
    expect(
      mobileStructuredSendDeliveryMode(true, false, idleChat, {
        alternate: true,
        isWorking: false,
        stopping: false
      })
    ).toBeUndefined()
    expect(
      mobileStructuredSendDeliveryMode(true, false, idleChat, {
        alternate: true,
        isWorking: true,
        stopping: true
      })
    ).toBeUndefined()
  })

  it('queues behind a waiting command card even with the setting off', () => {
    expect(
      mobileStructuredSendDeliveryMode(true, false, chatWithWaitingCommandCard(), {
        isWorking: true,
        stopping: false
      })
    ).toBe('queue-if-active')
  })

  it('ignores a paused command card, which is not waiting to send', () => {
    expect(
      mobileStructuredSendDeliveryMode(true, false, chatWithWaitingCommandCard(true), {
        isWorking: true,
        stopping: false
      })
    ).toBeUndefined()
  })

  it('never queues a steer, even working with the setting on and a command card waiting', () => {
    expect(
      mobileStructuredSendDeliveryMode(true, true, chatWithWaitingCommandCard(), {
        steer: true,
        isWorking: true,
        stopping: false
      })
    ).toBeUndefined()
  })

  it('never queues a steer that arrives while the agent works with the setting on', () => {
    expect(
      mobileStructuredSendDeliveryMode(true, true, idleChat, {
        steer: true,
        isWorking: true,
        stopping: false
      })
    ).toBeUndefined()
  })

  it('matches the queues rule it wraps for a non-steering send', () => {
    const send = { alternate: true, isWorking: true, stopping: false }
    for (const [queueCapable, queueFollowUps] of [
      [true, true],
      [true, false],
      [false, true]
    ] as const) {
      for (const state of [idleChat, chatWithWaitingCommandCard()]) {
        expect(mobileStructuredSendDeliveryMode(queueCapable, queueFollowUps, state, send)).toBe(
          mobileStructuredSendQueues(queueCapable, queueFollowUps, state, send)
            ? 'queue-if-active'
            : undefined
        )
      }
    }
  })
})

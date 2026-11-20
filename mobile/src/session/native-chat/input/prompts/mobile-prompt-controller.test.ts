import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './mobile-native-chat-prompt-dismissals'
import '../../composer/delivery/mobile-structured-send-delivery'
import '../../../structured-agent-send-result.test-fixture'
import type { RpcResponse } from '../../../../transport/rpc/rpc-wire-types'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'

import {
  session,
  structuredSession,
  baseTab,
  permissionTab,
  response,
  render,
  reset,
  unmount,
  sendButton,
  permissionAction,
  getController,
  askAnswer,
  visible,
  sendError,
  handleRef
} from '../../../__mocks__/mobile-prompt-controller'
import { mobileSessionTabPaneKey } from '../../../tabs/notification-pane-tab'

const client: RpcClient = {
  sendRequest: vi.fn<RpcClient['sendRequest']>(),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

beforeEach(() => {
  vi.mocked(client.sendRequest).mockReset().mockResolvedValue(response())
  reset(client)
})
afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('prompt cards through the production controller, send contract and view', () => {
  it.each(['refused', 'unverifiable'] as const)(
    'retains permission choices on %s',
    async (mode) => {
      vi.mocked(client.sendRequest).mockResolvedValue(response(false, mode))
      await render({ tab: permissionTab })
      await act(async () => {
        await permissionAction().props.onPress()
      })
      expect(getController().nativeChatPermission).not.toBe(null)
      expect(permissionAction().props.disabled).toBe(false)
      expect(sendButton().props.disabled).toBe(true)
      expect(client.sendRequest).toHaveBeenCalledWith(
        'terminal.send',
        expect.objectContaining({ requireWriteSettlement: true, enter: false, text: '\x1b' }),
        expect.any(Object)
      )
    }
  )

  it('keeps an acknowledged Deny hidden after the chat screen remounts on a lingering status', async () => {
    await render({ tab: permissionTab })
    await act(async () => {
      await permissionAction().props.onPress()
    })
    expect(sendButton().props.disabled).toBe(false)
    await unmount()
    await render({
      tab: { ...permissionTab, agentStatus: { ...permissionTab.agentStatus, updatedAt: 99 } }
    })
    expect(getController().nativeChatPermission).toBe(null)
    expect(sendButton().props.disabled).toBe(false)
  })
})

vi.mock('../queued-messages/MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))

describe('async occurrences through the phone controller and rendered card actions', () => {
  const row = (id: string, title = 'Q1?', callId?: string): NativeChatMessage => ({
    id,
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        callId,
        input: { questions: [{ title, options: ['Red', 'Blue'] }] }
      }
    ]
  })
  const structuredTab = {
    type: 'agent-session',
    id: 'tab-1',
    title: 'Chat',
    sessionId: 'session-1',
    agent: 'codex',
    isActive: true
  }
  const terminalTab = {
    ...baseTab,
    launchAgent: 'codex',
    agentStatus: { ...baseTab.agentStatus, agentType: 'codex' }
  }
  const titles = () => getController().nativeChatAsk?.questions.map((q) => q.question)

  it('settles the terminal answer for Q1 after Q2 arrives without hiding Q2', async () => {
    let finish: (reply: RpcResponse) => void = () => {
      throw new Error('not sent')
    }
    vi.mocked(client.sendRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const q1 = row('one')
    session.messages = [q1]
    await render({ tab: terminalTab })
    let answer: Promise<boolean> | undefined
    await act(async () => {
      answer = askAnswer([{ indices: [1] }])
    })
    session.messages = [q1, row('two', 'Q2?')]
    await render({ tab: terminalTab })
    await act(async () => {
      finish(response())
      await answer
    })
    expect(titles()).toEqual(['Q2?'])
  })

  it('keeps structured answer controls after a thrown send', async () => {
    structuredSession.sendWithOutcome.mockRejectedValue(new Error('send failed'))
    session.messages = [row('one')]
    await render({ tab: structuredTab })
    await act(async () => {
      await expect(askAnswer([{ indices: [1] }])).rejects.toThrow('send failed')
    })
    expect(titles()).toEqual(['Q1?'])
  })
})

describe('the voice loop holds its chat on the pane it started on', () => {
  const structuredTab = {
    type: 'agent-session',
    id: 'tab-1',
    title: 'Chat',
    sessionId: 'session-1',
    agent: 'codex',
    isActive: true
  }
  const paneKey = mobileSessionTabPaneKey(structuredTab)
  // The lane mock's send verb is typed without arguments; its calls carry the spoken text first.
  const sentText = (call: number): string =>
    (structuredSession.sendWithOutcome.mock.calls[call] as unknown as [string])[0]

  it('sends the held words to the structured chat while the active tab moves off it', async () => {
    await render({ tab: structuredTab, voiceOwnerPane: paneKey })
    expect(getController().nativeChatStructured).toBe(true)
    await act(async () => {
      await getController().handleNativeChatSend('held words')
    })
    expect(sentText(0)).toBe('held words')

    // The session's active tab leaves the chat and the overlay hides; the loop's lane and its
    // identity stand, so its sends keep riding the pane's structured chat.
    visible.value = false
    await render({ tab: baseTab, tabId: 'tab-2', voiceOwnerPane: paneKey })
    expect(getController().showNativeChat).toBe(false)
    expect(getController().nativeChatStructured).toBe(true)
    await act(async () => {
      await getController().handleNativeChatSend('more held words')
    })
    expect(sentText(1)).toBe('more held words')
    expect(sendError).not.toHaveBeenCalled()
  })

  it('releases the held chat when the loop ends, returning sends to the visible tab', async () => {
    await render({ tab: structuredTab, voiceOwnerPane: paneKey })
    visible.value = false
    await render({ tab: baseTab, tabId: 'tab-2', voiceOwnerPane: paneKey })
    expect(getController().nativeChatStructured).toBe(true)

    // The pane's loop is gone; nothing holds the chat anymore.
    await render({ tab: baseTab, tabId: 'tab-2', voiceOwnerPane: null })
    expect(getController().showNativeChat).toBe(false)
    expect(getController().nativeChatStructured).toBe(false)
    await act(async () => {
      await getController().handleNativeChatSend('after words')
    })
    expect(structuredSession.sendWithOutcome).not.toHaveBeenCalled()
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'after words' }),
      expect.any(Object)
    )
  })

  it('keeps the held words on the owner terminal while the active handle moves to another tab', async () => {
    const ownerLeaf = crypto.randomUUID()
    const ownerTab = { ...baseTab, id: 'tab-1', leafId: ownerLeaf }
    const terminalPane = mobileSessionTabPaneKey(ownerTab)
    await render({ tab: ownerTab, tabId: 'tab-1', voiceOwnerPane: terminalPane })
    expect(getController().showNativeChat).toBe(true)
    await act(async () => {
      await getController().handleNativeChatSend('spoken words')
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'spoken words', terminal: 'term-1' }),
      expect.any(Object)
    )

    // The active tab becomes a plain terminal of its own, with its own handle; the pane's
    // remembered handle keeps the loop's words off it, on the terminal the loop started on.
    handleRef.current = 'term-2'
    await render({
      tab: { type: 'terminal', id: 'tab-2', leafId: crypto.randomUUID() },
      tabId: 'tab-2',
      voiceOwnerPane: terminalPane
    })
    expect(getController().showNativeChat).toBe(false)
    await act(async () => {
      await getController().handleNativeChatSend('more spoken words')
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'more spoken words', terminal: 'term-1' }),
      expect.any(Object)
    )
    expect(client.sendRequest).not.toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ terminal: 'term-2' }),
      expect.any(Object)
    )
  })

  it('keeps the loop on its structured chat when the active tab moves to another chat pane', async () => {
    await render({ tab: structuredTab, tabId: 'tab-1', voiceOwnerPane: paneKey })
    expect(getController().nativeChatStructured).toBe(true)

    // Another pane's chat goes live and shown; the loop's chat still stands on its own pane, so
    // its sends ride that pane's structured session, never the newly live chat's terminal.
    await render({
      tab: { ...baseTab, id: 'tab-2', leafId: crypto.randomUUID() },
      tabId: 'tab-2',
      voiceOwnerPane: paneKey
    })
    expect(getController().showNativeChat).toBe(true)
    expect(getController().nativeChatStructured).toBe(true)
    expect(getController().nativeChatAgent).toBe('codex')
    await act(async () => {
      await getController().handleNativeChatSend('held words')
    })
    expect(sentText(0)).toBe('held words')
    expect(client.sendRequest).not.toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'held words' }),
      expect.any(Object)
    )
  })
})

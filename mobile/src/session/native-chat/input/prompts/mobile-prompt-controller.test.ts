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

describe('the voice loop rides the chat it captured at its start', () => {
  const structuredTab = {
    type: 'agent-session',
    id: 'tab-1',
    title: 'Chat',
    sessionId: 'session-1',
    agent: 'codex',
    isActive: true
  }
  // The lane mock's send verb is typed without arguments; its calls carry the spoken text first.
  const sentText = (call: number): string =>
    (structuredSession.sendWithOutcome.mock.calls[call] as unknown as [string])[0]

  it('sends the held words to the structured chat while the active tab moves off it', async () => {
    await render({ tab: structuredTab, tabId: 'tab-1' })
    const captured = getController().nativeChatVoiceOwnerChat()
    expect(captured?.structured).toBe(true)
    await render({ tab: structuredTab, tabId: 'tab-1', voiceOwnerChat: captured })
    await act(async () => {
      await getController().nativeChatVoiceSeam?.send('held words')
    })
    expect(sentText(0)).toBe('held words')

    // The session's active tab leaves the chat and the overlay hides; the visible controller
    // resolves the live tab — no chat — while the loop's captured seam keeps its own identity.
    visible.value = false
    await render({ tab: baseTab, tabId: 'tab-2', voiceOwnerChat: captured })
    expect(getController().showNativeChat).toBe(false)
    expect(getController().nativeChatStructured).toBe(false)
    await act(async () => {
      await getController().nativeChatVoiceSeam?.send('more held words')
    })
    expect(sentText(1)).toBe('more held words')
    expect(sendError).not.toHaveBeenCalled()
  })

  it('releases the captured seam when the loop ends, returning sends to the visible tab', async () => {
    await render({ tab: structuredTab, tabId: 'tab-1' })
    const captured = getController().nativeChatVoiceOwnerChat()
    visible.value = false
    await render({ tab: baseTab, tabId: 'tab-2', voiceOwnerChat: captured })
    expect(getController().nativeChatVoiceSeam).not.toBe(null)

    // The loop is gone; nothing holds a chat anymore.
    await render({ tab: baseTab, tabId: 'tab-2', voiceOwnerChat: null })
    expect(getController().showNativeChat).toBe(false)
    expect(getController().nativeChatStructured).toBe(false)
    expect(getController().nativeChatVoiceSeam).toBe(null)
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

  it('sends typed words to the live terminal while held words stay on the owner terminal', async () => {
    const ownerTab = { ...baseTab, id: 'tab-1', leafId: crypto.randomUUID() }
    await render({ tab: ownerTab, tabId: 'tab-1' })
    const captured = getController().nativeChatVoiceOwnerChat()
    expect(captured?.handle).toBe('term-1')

    // The active tab becomes another chat-capable terminal with its own handle; everything
    // visible — overlay, composer, typed sends — follows it, writing the user's selection.
    handleRef.current = 'term-2'
    await render({
      tab: { ...baseTab, id: 'tab-2', leafId: crypto.randomUUID() },
      tabId: 'tab-2',
      tabs: [
        { id: 'tab-1', type: 'terminal', agentStatus: ownerTab.agentStatus },
        { id: 'tab-2', type: 'terminal', agentStatus: ownerTab.agentStatus }
      ],
      voiceOwnerChat: captured
    })
    expect(getController().showNativeChat).toBe(true)
    expect(getController().nativeChatStructured).toBe(false)
    await act(async () => {
      await getController().handleNativeChatSend('typed words')
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'typed words', terminal: 'term-2' }),
      expect.any(Object)
    )
    // The loop's held words still type into the terminal it captured at the press.
    await act(async () => {
      await getController().nativeChatVoiceSeam?.send('spoken words')
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'spoken words', terminal: 'term-1' }),
      expect.any(Object)
    )
  })

  it('keeps held words on the captured structured chat while the visible chat follows a live terminal', async () => {
    await render({ tab: structuredTab, tabId: 'tab-1' })
    const captured = getController().nativeChatVoiceOwnerChat()
    expect(captured?.structured).toBe(true)

    // Another pane's chat-capable terminal goes live and shown; the visible controller resolves
    // it exactly as before voice mode, and typed sends ride its terminal.
    await render({
      tab: { ...baseTab, id: 'tab-2', leafId: crypto.randomUUID() },
      tabId: 'tab-2',
      voiceOwnerChat: captured
    })
    expect(getController().showNativeChat).toBe(true)
    expect(getController().nativeChatStructured).toBe(false)
    await act(async () => {
      await getController().handleNativeChatSend('typed words')
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'typed words' }),
      expect.any(Object)
    )
    // The loop's held words still ride the structured session it captured, never the terminal.
    await act(async () => {
      await getController().nativeChatVoiceSeam?.send('held words')
    })
    expect(sentText(0)).toBe('held words')
    expect(sendError).not.toHaveBeenCalled()
  })

  it('keeps held words on a paneless owner terminal while the active handle moves', async () => {
    const ownerTab = { ...baseTab }
    expect(mobileSessionTabPaneKey(ownerTab)).toBeUndefined()
    await render({ tab: ownerTab, tabId: 'tab-1' })
    const captured = getController().nativeChatVoiceOwnerChat()
    expect(captured?.handle).toBe('term-1')

    // The owner names no pane, and the session's active handle moves to another chat-capable
    // terminal; the seam still sends through the terminal it captured at the press.
    handleRef.current = 'term-2'
    await render({
      tab: { ...baseTab, id: 'tab-2' },
      tabId: 'tab-2',
      tabs: [
        { id: 'tab-1', type: 'terminal', agentStatus: ownerTab.agentStatus },
        { id: 'tab-2', type: 'terminal', agentStatus: ownerTab.agentStatus }
      ],
      voiceOwnerChat: captured
    })
    await act(async () => {
      await getController().nativeChatVoiceSeam?.send('held words')
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'held words', terminal: 'term-1' }),
      expect.any(Object)
    )
  })
})

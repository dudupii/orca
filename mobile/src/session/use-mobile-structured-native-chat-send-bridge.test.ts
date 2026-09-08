import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'

describe('useMobileStructuredNativeChatSendBridge', () => {
  let renderer: ReactTestRenderer | null = null
  let bridge: ReturnType<typeof useMobileStructuredNativeChatSendBridge> | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    bridge = null
  })

  function render(outcome: MobileNativeChatSendOutcome, reported: AgentSessionSlashCommand[]) {
    const args = {
      sendStructured: vi.fn(async () => outcome),
      captureSendOrigin: vi.fn(() => ({ id: 'origin-1' }) as unknown as MobileNativeChatSendOrigin),
      clearDraftForSend: vi.fn(),
      acceptSend: vi.fn(),
      holdUnconfirmedSend: vi.fn(),
      restoreRejectedDraft: vi.fn(),
      onSendError: vi.fn(),
      reportedCommands: reported
    }
    function Harness(): null {
      bridge = useMobileStructuredNativeChatSendBridge(args)
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    return args
  }

  it('does not echo a session-reported skill as an optimistic user bubble', async () => {
    const args = render('accepted', [
      { name: 'opsx:apply', kind: 'command' },
      { name: 'to-spec', kind: 'skill' }
    ])

    await act(async () => {
      expect(await bridge!.sendWithOutcome('/to-spec write the spec')).toBe('accepted')
    })

    expect(args.sendStructured).toHaveBeenCalledWith('/to-spec write the spec')
    expect(args.acceptSend).not.toHaveBeenCalled()
  })

  it('still echoes ordinary chat sends', async () => {
    const args = render('accepted', [])

    await act(async () => {
      expect(await bridge!.sendWithOutcome('hello there')).toBe('accepted')
    })

    expect(args.acceptSend).toHaveBeenCalledTimes(1)
  })

  it('restores the draft when a reported command send lands unknown', async () => {
    const args = render('unknown', [{ name: 'to-spec', kind: 'skill' }])

    await act(async () => {
      expect(await bridge!.sendWithOutcome('/to-spec')).toBe('unknown')
    })

    expect(args.restoreRejectedDraft).toHaveBeenCalledTimes(1)
    expect(args.holdUnconfirmedSend).not.toHaveBeenCalled()
  })
})

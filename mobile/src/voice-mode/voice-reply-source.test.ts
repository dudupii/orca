import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat/native-chat-types'
import { resolveVoiceModeReplyText } from './voice-reply-source'

function assistantMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

function statusEntry(fields: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'List the files',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: 'tab:leaf',
    stateHistory: [],
    ...fields
  }
}

describe('resolveVoiceModeReplyText', () => {
  it('reads the transcript as-is for structured chats', () => {
    const messages = [assistantMessage('a1', 'Two files.'), assistantMessage('a2', 'Three files.')]
    const status = statusEntry({ lastAssistantMessage: 'Preview channel text.' })
    expect(resolveVoiceModeReplyText({ structured: true, messages, status })).toBe('Three files.')
    expect(resolveVoiceModeReplyText({ structured: true, messages: [], status: null })).toBe('')
  })

  it('speaks the preview on a terminal chat', () => {
    const status = statusEntry({ lastAssistantMessage: 'All checks pass.' })
    expect(resolveVoiceModeReplyText({ structured: false, messages: [], status })).toBe(
      'All checks pass.'
    )
  })

  it('falls to the completed snapshot when the live preview is tool output', () => {
    const status = statusEntry({
      lastAssistantMessage: '3 files, 12 dirs',
      lastAssistantMessageIsToolOutput: true,
      lastCompletedAssistantMessage: 'The src folder is tidy.'
    })
    expect(resolveVoiceModeReplyText({ structured: false, messages: [], status })).toBe(
      'The src folder is tidy.'
    )
  })

  it('keeps the completed snapshot when a working ping cleared the live preview', () => {
    const status = statusEntry({
      state: 'working',
      lastAssistantMessage: '',
      lastCompletedAssistantMessage: 'First turn done.'
    })
    expect(resolveVoiceModeReplyText({ structured: false, messages: [], status })).toBe(
      'First turn done.'
    )
  })

  it('discards a preview that only echoes the prompt', () => {
    const status = statusEntry({
      lastAssistantMessage: 'List the files',
      lastCompletedAssistantMessage: 'Earlier reply.'
    })
    expect(resolveVoiceModeReplyText({ structured: false, messages: [], status })).toBe(
      'Earlier reply.'
    )
    expect(
      resolveVoiceModeReplyText({
        structured: false,
        messages: [],
        status: statusEntry({ lastAssistantMessage: 'List the files' })
      })
    ).toBe('')
  })

  it('strips visual directive lines from the preview', () => {
    const status = statusEntry({
      lastAssistantMessage: 'Here is the chart.\n::orca-visual{file="usage.html" title="Usage"}'
    })
    expect(resolveVoiceModeReplyText({ structured: false, messages: [], status })).toBe(
      'Here is the chart.'
    )
  })

  it('answers empty when no status row carries a reply', () => {
    expect(resolveVoiceModeReplyText({ structured: false, messages: [], status: null })).toBe('')
    expect(resolveVoiceModeReplyText({ structured: false, messages: [], status: undefined })).toBe(
      ''
    )
    expect(
      resolveVoiceModeReplyText({
        structured: false,
        messages: [],
        status: statusEntry({ lastAssistantMessage: '   ' })
      })
    ).toBe('')
  })
})

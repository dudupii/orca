import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { readSpeakBroadcast, subscribeToSpeakBroadcasts } from './speak-broadcast'

describe('readSpeakBroadcast', () => {
  it('narrows a speak notification into the readout briefing shape', () => {
    expect(
      readSpeakBroadcast({
        type: 'notification',
        source: 'speak',
        title: 'Speak',
        body: 'Checks pass.',
        speakLang: 'zh-CN',
        speakSession: 'session-7'
      })
    ).toEqual({ text: 'Checks pass.', lang: 'zh-CN', session: 'session-7' })
  })

  it('keeps absent language and session null', () => {
    expect(
      readSpeakBroadcast({ type: 'notification', source: 'speak', body: 'Plain words.' })
    ).toEqual({ text: 'Plain words.', lang: null, session: null })
  })

  it('refuses every other wire frame', () => {
    expect(readSpeakBroadcast(null)).toBeNull()
    expect(readSpeakBroadcast('notification')).toBeNull()
    expect(readSpeakBroadcast({ type: 'ready' })).toBeNull()
    expect(readSpeakBroadcast({ type: 'end' })).toBeNull()
    expect(
      readSpeakBroadcast({ type: 'notification', source: 'agent-task-complete', body: 'Done' })
    ).toBeNull()
    // An empty broadcast would hand the readout nothing to say; it is not one.
    expect(readSpeakBroadcast({ type: 'notification', source: 'speak', body: '' })).toBeNull()
  })
})

describe('subscribeToSpeakBroadcasts', () => {
  it('subscribes with desktop-suppressed events included and forwards only speak broadcasts', () => {
    const listeners: ((data: unknown) => void)[] = []
    const subscribe = vi.fn((_method: string, params: unknown, onData: (data: unknown) => void) => {
      listeners.push(onData)
      return () => undefined
    })
    const client = { subscribe } as unknown as RpcClient
    const seen: unknown[] = []
    const unsubscribe = subscribeToSpeakBroadcasts(client, (broadcast) => seen.push(broadcast))

    expect(subscribe.mock.calls[0][0]).toBe('notifications.subscribe')
    expect(subscribe.mock.calls[0][1]).toEqual({ includeDesktopSuppressed: true })
    listeners[0]!({ type: 'notification', source: 'speak', body: 'Spoken.' })
    listeners[0]!({ type: 'notification', source: 'plugin', body: 'Ignored.' })
    listeners[0]!({ type: 'dismiss', notificationId: 'n1' })
    expect(seen).toEqual([{ text: 'Spoken.', lang: null, session: null }])

    unsubscribe()
  })
})

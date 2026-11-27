import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OnDeviceTtsChannel,
  OnDeviceTtsChannelRead
} from '../platform/tts/on-device-tts-contract'
import { createVoiceReadout } from './voice-readout'

// The poll pace voice-readout reads endings at; tests advance the clock by it.
const READ_INTERVAL_MS = 150

type FakeChannel = OnDeviceTtsChannel & {
  readonly utterances: { text: string; locale: string | null }[]
  readonly stops: number
  /** Drives the next reads: each poll consumes the front entry, repeating the last one. */
  queueReads: (reads: OnDeviceTtsChannelRead[]) => void
}

// A channel the tests drive by hand: speak claims revisions in order, reads answer from a queue.
function fakeChannel(firstRevision = 1): FakeChannel {
  const utterances: { text: string; locale: string | null }[] = []
  let stops = 0
  let next = firstRevision
  let queued: OnDeviceTtsChannelRead[] = []
  return {
    get utterances() {
      return utterances
    },
    get stops() {
      return stops
    },
    queueReads(reads) {
      queued = reads
    },
    speak: (utterance) => {
      utterances.push({ text: utterance.text, locale: utterance.locale })
      return Promise.resolve({ revision: next++ })
    },
    stop: () => {
      stops += 1
      return Promise.resolve()
    },
    read: () => {
      const read =
        queued.length > 1
          ? queued.shift()!
          : (queued[0] ?? { revision: 0, status: 'idle', reason: null })
      return Promise.resolve(read)
    }
  }
}

describe('createVoiceReadout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the latest briefing of a turn and clears it when the next turn begins', () => {
    const readout = createVoiceReadout({ playback: fakeChannel() })
    expect(readout.settleBriefing()).toBeNull()
    readout.briefingArrived({ text: 'First.', lang: null, session: 's1' })
    readout.briefingArrived({ text: 'Second.', lang: 'zh-CN', session: 's1' })
    expect(readout.settleBriefing()).toEqual({ text: 'Second.', lang: 'zh-CN' })
    readout.beginTurn()
    expect(readout.settleBriefing()).toBeNull()
  })

  it('plays an utterance and settles done when the shell reports its end', async () => {
    const channel = fakeChannel()
    const readout = createVoiceReadout({ playback: channel })
    channel.queueReads([{ revision: 1, status: 'speaking', reason: null }])
    const playing = readout.play({ text: 'Words.', locale: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    channel.queueReads([{ revision: 1, status: 'done', reason: null }])
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    await expect(playing).resolves.toBe('done')
    expect(channel.utterances).toEqual([{ text: 'Words.', locale: null }])
  })

  it('settles stopped when the shell reports the claim was stopped', async () => {
    const channel = fakeChannel()
    const readout = createVoiceReadout({ playback: channel })
    channel.queueReads([{ revision: 1, status: 'stopped', reason: null }])
    const playing = readout.play({ text: 'Words.', locale: 'zh-CN' })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    await expect(playing).resolves.toBe('stopped')
    expect(channel.utterances[0]?.locale).toBe('zh-CN')
  })

  it('settles interrupted when a newer revision displaced the claim', async () => {
    const channel = fakeChannel()
    const readout = createVoiceReadout({ playback: channel })
    channel.queueReads([{ revision: 2, status: 'speaking', reason: null }])
    const playing = readout.play({ text: 'Words.', locale: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    await expect(playing).resolves.toBe('interrupted')
  })

  it('settles failed on the claim failure, keeping the coarse reason on the channel read', async () => {
    const channel = fakeChannel()
    const readout = createVoiceReadout({ playback: channel })
    channel.queueReads([{ revision: 1, status: 'failed', reason: 'busy' }])
    const playing = readout.play({ text: 'Words.', locale: null })
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    await expect(playing).resolves.toBe('failed')
  })

  it('settles failed without claiming when the shell grants no tts verb', async () => {
    const channel = fakeChannel()
    const readout = createVoiceReadout({ playback: null })
    await expect(readout.play({ text: 'Words.', locale: null })).resolves.toBe('failed')
    expect(channel.utterances).toEqual([])
  })

  it('settles failed when the bridge refuses the speak or a read', async () => {
    const refused: OnDeviceTtsChannel = {
      speak: () => Promise.reject(new Error('ungranted')),
      stop: () => Promise.resolve(),
      read: () => Promise.reject(new Error('ungranted'))
    }
    const readout = createVoiceReadout({ playback: refused })
    await expect(readout.play({ text: 'Words.', locale: null })).resolves.toBe('failed')
  })

  it('stops through the channel and never throws on a refusing bridge', async () => {
    const channel = fakeChannel()
    const readout = createVoiceReadout({ playback: channel })
    channel.queueReads([{ revision: 1, status: 'speaking', reason: null }])
    const playing = readout.play({ text: 'Words.', locale: null })
    readout.stop()
    expect(channel.stops).toBe(1)
    channel.queueReads([{ revision: 1, status: 'stopped', reason: null }])
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    await expect(playing).resolves.toBe('stopped')

    const refusing: OnDeviceTtsChannel = {
      speak: () => Promise.resolve({ revision: 1 }),
      stop: () => Promise.reject(new Error('bridge gone')),
      read: () => Promise.resolve({ revision: 1, status: 'idle', reason: null })
    }
    expect(() => createVoiceReadout({ playback: refusing }).stop()).not.toThrow()
  })
})

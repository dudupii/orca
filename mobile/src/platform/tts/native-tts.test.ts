import { describe, expect, it } from 'vitest'
import { createNativeTtsServer, type NativeTtsEngine } from './native-tts'

// A fake engine the tests drive by hand: it records the verbs it was given and fires events when told to.
function fakeEngine() {
  const calls: string[] = []
  const given: { utteranceId: string; text: string; locale: string | null }[] = []
  const done: { emit: (utteranceId: string) => void } = { emit: () => {} }
  const failed: { emit: (utteranceId: string, code: string) => void } = { emit: () => {} }
  const controls = {
    // Tests may replace how the engine answers a start; the default takes every utterance.
    start: async (): Promise<{ started: boolean; reason: string | null }> => ({
      started: true,
      reason: null
    })
  }
  const engine: NativeTtsEngine = {
    speak: (utteranceId, text, locale) => {
      calls.push(`speak ${utteranceId}`)
      given.push({ utteranceId, text, locale })
      return controls.start()
    },
    stop: () => {
      calls.push('stop')
    },
    onDone: (handler) => {
      done.emit = handler
    },
    onError: (handler) => {
      failed.emit = handler
    }
  }
  return { engine, calls, given, done, failed, controls }
}

describe('a new utterance while one is playing', () => {
  it('interrupts the playing one and settles it interrupted', async () => {
    const fake = fakeEngine()
    const server = createNativeTtsServer(fake.engine)
    const first = server.speak({ text: 'first words', locale: null })
    expect(server.state()).toEqual({ status: 'speaking' })
    const second = server.speak({ text: 'second words', locale: 'zh-CN' })
    await expect(first).resolves.toEqual({ status: 'interrupted' })
    expect(server.state()).toEqual({ status: 'speaking' })
    // The engine is stopped before the next utterance is given to it, and each speak passes its own words and language.
    expect(fake.calls).toEqual(['stop', 'speak tts-0', 'stop', 'speak tts-1'])
    expect(fake.given).toEqual([
      { utteranceId: 'tts-0', text: 'first words', locale: null },
      { utteranceId: 'tts-1', text: 'second words', locale: 'zh-CN' }
    ])
    fake.done.emit('tts-1')
    await expect(second).resolves.toEqual({ status: 'done' })
    expect(server.state()).toEqual({ status: 'idle' })
  })
})

describe('an explicit stop', () => {
  it('clears the playback state and settles the live utterance as stopped', async () => {
    const fake = fakeEngine()
    const server = createNativeTtsServer(fake.engine)
    const speaking = server.speak({ text: 'words', locale: null })
    // Let the engine take the utterance before stopping, so this is a stop during playback, not while arming.
    await new Promise((resolve) => setTimeout(resolve, 0))
    server.stop()
    expect(server.state()).toEqual({ status: 'idle' })
    await expect(speaking).resolves.toEqual({ status: 'stopped' })
    // The engine's late confirmation of the cut-short utterance changes nothing.
    fake.done.emit('tts-0')
    expect(server.state()).toEqual({ status: 'idle' })
    expect(fake.calls).toEqual(['stop', 'speak tts-0', 'stop'])
  })
})

describe('an engine that refuses the utterance', () => {
  it('settles the speak as failed and leaves the state idle', async () => {
    const fake = fakeEngine()
    fake.controls.start = async () => ({ started: false, reason: 'unsupported' })
    const server = createNativeTtsServer(fake.engine)
    await expect(server.speak({ text: 'words', locale: null })).resolves.toEqual({
      status: 'failed',
      reason: 'unsupported'
    })
    expect(server.state()).toEqual({ status: 'idle' })
  })
})

describe('an engine error while playing', () => {
  it("surfaces as the speak's failure, an unknown code kept coarse", async () => {
    const fake = fakeEngine()
    const server = createNativeTtsServer(fake.engine)
    const speaking = server.speak({ text: 'words', locale: null })
    fake.failed.emit('tts-0', 'engine-vanished')
    await expect(speaking).resolves.toEqual({ status: 'failed', reason: 'failed' })
    expect(server.state()).toEqual({ status: 'idle' })
  })
})

describe('a second voice consumer over the same speaker', () => {
  it("has its speak interrupt the first's utterance, and its stop silence whoever is speaking", async () => {
    const fake = fakeEngine()
    const first = createNativeTtsServer(fake.engine)
    const second = createNativeTtsServer(fake.engine)
    const firstWords = first.speak({ text: 'first words', locale: null })
    const secondWords = second.speak({ text: 'second words', locale: null })
    await expect(firstWords).resolves.toEqual({ status: 'interrupted' })
    second.stop()
    await expect(secondWords).resolves.toEqual({ status: 'stopped' })
    expect(second.state()).toEqual({ status: 'idle' })
  })
})

describe('an engine that finishes arming after its utterance was stopped', () => {
  it('has the late arm silenced, so the phone never speaks into a dead session', async () => {
    const fake = fakeEngine()
    let resolveStart: (value: { started: boolean; reason: string | null }) => void = () => {}
    fake.controls.start = () =>
      new Promise((resolve) => {
        resolveStart = resolve
      })
    const server = createNativeTtsServer(fake.engine)
    const speaking = server.speak({ text: 'words', locale: null })
    server.stop()
    await expect(speaking).resolves.toEqual({ status: 'stopped' })
    resolveStart({ started: true, reason: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.calls).toEqual(['stop', 'speak tts-0', 'stop', 'stop'])
  })
})

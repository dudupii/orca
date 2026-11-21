import { describe, expect, it } from 'vitest'
import { createNativeTtsServer, type NativeTtsEngine } from './native-tts'
import { createNativeTtsVerbServer } from './native-tts-verb-server'

// A fake engine the tests drive by hand: it takes every utterance until a test fires its events.
function fakeEngine() {
  const done: { emit: (utteranceId: string) => void } = { emit: () => {} }
  const failed: { emit: (utteranceId: string, code: string) => void } = { emit: () => {} }
  const engine: NativeTtsEngine = {
    speak: () => Promise.resolve({ started: true, reason: null }),
    stop: () => {},
    onDone: (handler) => {
      done.emit = handler
    },
    onError: (handler) => {
      failed.emit = handler
    }
  }
  return { engine, done, failed }
}

async function speakRevision(
  server: ReturnType<typeof createNativeTtsVerbServer>,
  text: string
): Promise<number> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture shaping; the stub exercises only the fields under test
  const reply = (await server.serve({ action: 'speak', text, locale: null })) as {
    revision: number
  }
  return reply.revision
}

// A settle lands on latest one microtask after its event fires; the page polls across the bridge, tests flush.
async function readLatest(server: ReturnType<typeof createNativeTtsVerbServer>): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return server.serve({ action: 'read' })
}

describe('a speak', () => {
  it('settles at claim time with the revision its ending will be read under', async () => {
    const fake = fakeEngine()
    const server = createNativeTtsVerbServer(createNativeTtsServer(fake.engine))
    expect(await speakRevision(server, 'words')).toBe(1)
    expect(await readLatest(server)).toEqual({
      revision: 1,
      status: 'speaking',
      reason: null
    })
  })

  it('reports the utterance done once the engine finishes it', async () => {
    const fake = fakeEngine()
    const server = createNativeTtsVerbServer(createNativeTtsServer(fake.engine))
    await speakRevision(server, 'words')
    fake.done.emit('tts-0')
    expect(await readLatest(server)).toEqual({
      revision: 1,
      status: 'done',
      reason: null
    })
  })

  it('carries an engine failure coarsely', async () => {
    const fake = fakeEngine()
    const server = createNativeTtsVerbServer(createNativeTtsServer(fake.engine))
    await speakRevision(server, 'words')
    fake.failed.emit('tts-0', 'engine-vanished')
    expect(await readLatest(server)).toEqual({
      revision: 1,
      status: 'failed',
      reason: 'failed'
    })
  })
})

describe('a stop', () => {
  it('settles the live claim as stopped, visible on the next read', async () => {
    const fake = fakeEngine()
    const server = createNativeTtsVerbServer(createNativeTtsServer(fake.engine))
    await speakRevision(server, 'words')
    await expect(server.serve({ action: 'stop' })).resolves.toEqual({})
    expect(await readLatest(server)).toEqual({
      revision: 1,
      status: 'stopped',
      reason: null
    })
  })
})

describe('a newer claim displacing an older one', () => {
  it('reads under the newer revision, which an older poll sees as interruption', async () => {
    const fake = fakeEngine()
    const server = createNativeTtsVerbServer(createNativeTtsServer(fake.engine))
    const first = await speakRevision(server, 'first words')
    const second = await speakRevision(server, 'second words')
    expect(second).toBeGreaterThan(first)
    expect(await readLatest(server)).toEqual({
      revision: second,
      status: 'speaking',
      reason: null
    })
  })
})

describe('dispose', () => {
  it('silences a live claim and reports it stopped', async () => {
    const fake = fakeEngine()
    const server = createNativeTtsVerbServer(createNativeTtsServer(fake.engine))
    await speakRevision(server, 'words')
    server.dispose()
    expect(await readLatest(server)).toEqual({
      revision: 1,
      status: 'stopped',
      reason: null
    })
  })
})

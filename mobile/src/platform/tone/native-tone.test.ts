import { describe, expect, it } from 'vitest'
import { serveNativeToneVerb, type NativeToneEngine } from './native-tone'

// A fake engine the tests drive by hand; the serving only forwards the parsed kind and never
// reaches the device audio these tests cannot sound.
describe('the shell side of native.tone.act', () => {
  it('plays the parsed kind and replies with nothing to carry back', async () => {
    const played: string[] = []
    const engine: NativeToneEngine = { play: (kind) => void played.push(kind) }
    await expect(serveNativeToneVerb(engine, { kind: 'restore' })).resolves.toEqual({})
    expect(played).toEqual(['restore'])
  })

  it('asks the engine once per ask, leaving nothing queued behind it', async () => {
    const played: string[] = []
    const engine: NativeToneEngine = { play: (kind) => void played.push(kind) }
    await serveNativeToneVerb(engine, { kind: 'restore' })
    await serveNativeToneVerb(engine, { kind: 'restore' })
    expect(played).toEqual(['restore', 'restore'])
  })
})

import { describe, expect, it } from 'vitest'
import type { DictationEnginePreference } from '../../mobile-web-shell/bridge/native-capabilities/bridge-speech-verbs'
import { createNativeSpeechServer, type NativeSpeechEngine } from './native-speech'

function engineWith(preference: DictationEnginePreference): NativeSpeechEngine {
  return {
    availability: async () => ({ status: 'ready', locale: 'en-US' }),
    start: async (locale) => ({ started: true, locale }),
    finish: async () => '',
    cancel: () => {},
    readPreference: async () => preference,
    recognitionLocale: async () => null,
    onText: () => {},
    onError: () => {}
  }
}

describe('a page asking for the microphone when the user chose This phone', () => {
  it('is refused unless its own recognizer is armed', async () => {
    const server = createNativeSpeechServer(engineWith('phone'))
    // An older page streams the mic to the computer without arming anything.
    expect(await server.mayCapture()).toBe(false)
    await server.serve({ action: 'start', locale: 'en-US' })
    expect(await server.mayCapture()).toBe(true)
    await server.serve({ action: 'cancel' })
    expect(await server.mayCapture()).toBe(false)
  })
})

describe('a recognizer another page took over', () => {
  it('reports the first page’s session as failed so it falls back', async () => {
    const engine = engineWith('automatic')
    const first = createNativeSpeechServer(engine)
    const second = createNativeSpeechServer(engine)
    await first.serve({ action: 'start', locale: 'en-US' })
    await second.serve({ action: 'start', locale: 'en-US' })
    expect(await first.serve({ action: 'read' })).toEqual({
      revision: 0,
      committed: '',
      tentative: '',
      failure: 'failed'
    })
    expect(await second.serve({ action: 'read' })).toMatchObject({ failure: null })
  })
})

describe('text a cancelled session sends while the next one is arming', () => {
  it('is dropped rather than shown as the new dictation’s words', async () => {
    const text: {
      emit: (event: { revision: number; committed: string; tentative: string }) => void
    } = {
      emit: () => {}
    }
    let resolveStart: (value: { started: true; locale: string }) => void = () => {}
    let startedArming: () => void = () => {}
    const arming = new Promise<void>((resolve) => {
      startedArming = resolve
    })
    const engine: NativeSpeechEngine = {
      ...engineWith('automatic'),
      start: () => {
        startedArming()
        return new Promise((resolve) => {
          resolveStart = resolve
        })
      },
      onText: (handler) => {
        text.emit = handler
      }
    }
    const server = createNativeSpeechServer(engine)
    const starting = server.serve({ action: 'start', locale: 'en-US' })
    // The locale resolves before the engine is asked, so wait for the arm itself before feeding it events.
    await arming
    text.emit({ revision: 3, committed: 'old words', tentative: '' })
    resolveStart({ started: true, locale: 'en-US' })
    await starting
    expect(await server.serve({ action: 'read' })).toMatchObject({ committed: '' })
    text.emit({ revision: 1, committed: 'new words', tentative: '' })
    expect(await server.serve({ action: 'read' })).toMatchObject({ committed: 'new words' })
  })
})

describe('a recognizer that fails while its start is still resolving', () => {
  it('reports the failure once armed, so the page stops recording into nothing', async () => {
    const error: { emit: (code: string) => void } = { emit: () => {} }
    let resolveStart: (value: { started: true; locale: string }) => void = () => {}
    let startedArming: () => void = () => {}
    const arming = new Promise<void>((resolve) => {
      startedArming = resolve
    })
    const engine: NativeSpeechEngine = {
      ...engineWith('automatic'),
      start: () => {
        startedArming()
        return new Promise((resolve) => {
          resolveStart = resolve
        })
      },
      onError: (handler) => {
        error.emit = handler
      }
    }
    const server = createNativeSpeechServer(engine)
    const starting = server.serve({ action: 'start', locale: 'en-US' })
    await arming
    error.emit('failed')
    resolveStart({ started: true, locale: 'en-US' })
    await starting
    expect(await server.serve({ action: 'read' })).toMatchObject({ failure: 'failed' })
  })
})

describe('a recognition language chosen in the shell', () => {
  it('arms the recognizer in it instead of the page’s locale', async () => {
    let startedWith = ''
    const engine: NativeSpeechEngine = {
      ...engineWith('automatic'),
      recognitionLocale: async () => 'ja',
      start: async (locale) => {
        startedWith = locale
        return { started: true, locale: 'ja-JP' }
      }
    }
    const server = createNativeSpeechServer(engine)
    expect(await server.serve({ action: 'start', locale: 'zh-CN' })).toEqual({
      started: true,
      locale: 'ja-JP',
      reason: null
    })
    expect(startedWith).toBe('ja')
  })

  it('probes availability in it instead of the page’s locale', async () => {
    let asked = ''
    const engine: NativeSpeechEngine = {
      ...engineWith('automatic'),
      recognitionLocale: async () => 'ja',
      availability: async (locale) => {
        asked = locale
        return { status: 'ready', locale: 'ja-JP' }
      }
    }
    const server = createNativeSpeechServer(engine)
    expect(await server.serve({ action: 'status', locale: 'zh-CN' })).toEqual({
      status: 'ready',
      locale: 'ja-JP',
      preference: 'automatic'
    })
    expect(asked).toBe('ja')
  })

  it('answers status honestly when the choice still needs its language downloaded', async () => {
    let asked = ''
    const engine: NativeSpeechEngine = {
      ...engineWith('automatic'),
      recognitionLocale: async () => 'ja',
      availability: async (locale) => {
        asked = locale
        // Only the chosen language is missing its download; the page's own locale is ready.
        return locale === 'ja'
          ? { status: 'needs-download', locale: 'ja-JP' }
          : { status: 'ready', locale: 'zh-CN' }
      }
    }
    const server = createNativeSpeechServer(engine)
    expect(await server.serve({ action: 'status', locale: 'zh-CN' })).toEqual({
      status: 'needs-download',
      locale: 'ja-JP',
      preference: 'automatic'
    })
    expect(asked).toBe('ja')
  })
})

describe('the recognition language left to the system', () => {
  it('passes the page’s locale through to the engine unchanged', async () => {
    let asked = ''
    let startedWith = ''
    const engine: NativeSpeechEngine = {
      ...engineWith('automatic'),
      recognitionLocale: async () => null,
      availability: async (locale) => {
        asked = locale
        return { status: 'ready', locale: 'en-US' }
      },
      start: async (locale) => {
        startedWith = locale
        return { started: true, locale }
      }
    }
    const server = createNativeSpeechServer(engine)
    expect(await server.serve({ action: 'status', locale: 'zh-CN' })).toEqual({
      status: 'ready',
      locale: 'en-US',
      preference: 'automatic'
    })
    expect(await server.serve({ action: 'start', locale: 'zh-CN' })).toEqual({
      started: true,
      locale: 'zh-CN',
      reason: null
    })
    expect(asked).toBe('zh-CN')
    expect(startedWith).toBe('zh-CN')
  })
})

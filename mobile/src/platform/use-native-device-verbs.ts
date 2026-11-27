import { useEffect, useMemo } from 'react'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/native-capabilities/bridge-native-verbs'
import type { BRIDGE_STORE_VERB } from '../mobile-web-shell/bridge/native-capabilities/bridge-store-verb'
import { useMediaHandleRegistry } from '../mobile-web-shell/native-capabilities/use-media-handle-registry'
import { createNativeAudioCapture } from './audio-capture/native-audio'
import {
  NATIVE_AUDIO_DEVICE_SAMPLE_RATE,
  nativeAudioDeviceEngine
} from './audio-capture/native-audio-device'
import { createNativeSpeechServer } from './speech/native-speech'
import { nativeSpeechDeviceEngine } from './speech/native-speech-device'
import { createNativeTtsServer } from './tts/native-tts'
import { nativeTtsDeviceEngine } from './tts/native-tts-device'
import { createNativeTtsVerbServer } from './tts/native-tts-verb-server'
import { serveNativeToneVerb } from './tone/native-tone'
import { nativeToneDeviceEngine } from './tone/native-tone-device'
import { serveNativeClipboardVerb } from './clipboard/native-clipboard'
import { serveNativeAnnounceVerb } from './accessibility/native-accessibility-announce'
import { createNativeMediaVerbServer } from './media-picking/native-media'
import { discardStagedMedia, nativeMediaDeviceDeps } from './media-picking/native-media-device'

export type NativeDeviceVerb = Exclude<
  BridgeNativeVerb,
  'native.storage.read' | 'native.pdf.view' | 'native.image.act' | typeof BRIDGE_STORE_VERB
>

// Tie stateful audio/media handlers to the page session so replacement documents cannot inherit abandoned microphones or staged handles.
export function useNativeDeviceVerbs(
  sessionId: string | null
): (verb: NativeDeviceVerb, params: unknown) => Promise<unknown> {
  const registry = useMediaHandleRegistry({ sessionId, discard: discardStagedMedia })
  const serveMedia = useMemo(
    () => createNativeMediaVerbServer(nativeMediaDeviceDeps(registry)),
    [registry]
  )
  // A new session is a new document; close any mic its predecessor left open.
  const audio = useMemo(() => createNativeAudioCapture(nativeAudioDeviceEngine), [sessionId])
  useEffect(() => () => audio.dispose(), [audio])
  const speech = useMemo(() => createNativeSpeechServer(nativeSpeechDeviceEngine), [sessionId])
  useEffect(() => () => speech.dispose(), [speech])
  // Playback outlives no page either: a new session's server silences what its predecessor left playing.
  const tts = useMemo(
    () => createNativeTtsVerbServer(createNativeTtsServer(nativeTtsDeviceEngine)),
    [sessionId]
  )
  useEffect(() => () => tts.dispose(), [tts])
  return useMemo(
    () => (verb, params) => {
      if (verb === 'native.clipboard.write' || verb === 'native.clipboard.read') {
        return serveNativeClipboardVerb(verb, params)
      }
      if (verb === 'native.speech.act') {
        return speech.serve(params)
      }
      if (verb === 'native.tts.act') {
        return tts.serve(params)
      }
      // A chime holds no session state to tie down; the engine call is the whole of it.
      if (verb === 'native.tone.act') {
        return serveNativeToneVerb(nativeToneDeviceEngine, params)
      }
      if (verb === 'native.a11y.announce') {
        return Promise.resolve(serveNativeAnnounceVerb(params))
      }
      if (verb === 'native.audio.start') {
        return speech.mayCapture().then((may) =>
          may
            ? audio.serve(verb, params)
            : {
                started: false,
                sampleRate: NATIVE_AUDIO_DEVICE_SAMPLE_RATE,
                permission: 'granted'
              }
        )
      }
      return verb.startsWith('native.audio.') ? audio.serve(verb, params) : serveMedia(verb, params)
    },
    [audio, serveMedia, speech, tts]
  )
}

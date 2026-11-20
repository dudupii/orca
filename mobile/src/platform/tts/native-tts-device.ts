import { addExpoTwoWayAudioEventListener, ttsSpeak, ttsStop } from '@orca/expo-two-way-audio'
import type { NativeTtsEngine } from './native-tts'

// Isolate the device module so tests drive the server with a fake engine.
export const nativeTtsDeviceEngine: NativeTtsEngine = {
  speak: (utteranceId, text, locale) => ttsSpeak(utteranceId, text, locale),
  stop: () => ttsStop(),
  onDone: (handler) => {
    addExpoTwoWayAudioEventListener('onTtsDone', (event) => handler(event.utteranceId))
  },
  onError: (handler) => {
    addExpoTwoWayAudioEventListener('onTtsError', (event) => handler(event.utteranceId, event.code))
  }
}

import { tonePlay } from '@orca/expo-two-way-audio'
import type { NativeToneEngine } from './native-tone'

// Isolate the device module so tests drive the serving with a fake engine.
export const nativeToneDeviceEngine: NativeToneEngine = {
  play: (kind) => tonePlay(kind)
}

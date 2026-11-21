import type { OnDeviceTtsChannel } from './on-device-tts-contract'

// The session screen is a page in the shell (on-device-tts.web.ts); native screens do not read replies aloud.
export function useOnDeviceTts(): OnDeviceTtsChannel | null {
  return null
}

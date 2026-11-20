import type { OnDeviceTone } from './on-device-tone-contract'

// The session screen is a page in the shell (on-device-tone.web.ts); native screens do not chime.
export function useOnDeviceTone(): OnDeviceTone | null {
  return null
}

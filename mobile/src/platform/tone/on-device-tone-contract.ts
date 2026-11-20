// The phone's short chimes as the voice loop sees them. One kind today: restore, the blip that
// says foreground voice mode came back.

export const ON_DEVICE_TONE_KINDS = ['restore'] as const

export type OnDeviceToneKind = (typeof ON_DEVICE_TONE_KINDS)[number]

// play is fire-and-forget: a chime that cannot sound is silence, never an error the caller must
// handle. The kind list is the whole surface — no volume, no duration, nothing to configure.
export type OnDeviceTone = {
  readonly play: (kind: OnDeviceToneKind) => void
}

// The phone's own text-to-speech as the voice loop sees it. One utterance at a time: a new speak
// interrupts the playing one, stop silences everything, and each speak settles with how its utterance ended.

export type OnDeviceTtsUtterance = {
  readonly text: string
  // The language to speak in; null lets the phone's own language choose.
  readonly locale: string | null
}

// Why an utterance did not play. Keep them coarse: every code means the caller gives up on that utterance.
export const ON_DEVICE_TTS_FAILURES = ['unsupported', 'busy', 'failed'] as const

export type OnDeviceTtsFailure = (typeof ON_DEVICE_TTS_FAILURES)[number]

export type OnDeviceTtsResult =
  // Played to its end.
  | { status: 'done' }
  // A newer utterance took the speaker.
  | { status: 'interrupted' }
  // stop() or dispose() ended it.
  | { status: 'stopped' }
  | { status: 'failed'; reason: OnDeviceTtsFailure }

// The playback snapshot the voice loop and its status pill read; which utterance is behind it stays a seam detail.
export type OnDeviceTtsPlayback = { status: 'idle' } | { status: 'speaking' }

// The consumer-facing playback contract: speak, stop, state. No engine detail reaches past it.
export type OnDeviceTts = {
  readonly speak: (utterance: OnDeviceTtsUtterance) => Promise<OnDeviceTtsResult>
  readonly stop: () => void
  readonly state: () => OnDeviceTtsPlayback
}

// The page-side view of the shell's playback. A speak reply only claims a revision; how the utterance
// ended — done, stopped by the loop, interrupted by a newer claim, failed — arrives on later reads,
// because the bridge has no push lane and playback outlives the speak call that started it.
export type OnDeviceTtsChannel = {
  readonly speak: (utterance: OnDeviceTtsUtterance) => Promise<{ revision: number }>
  readonly stop: () => Promise<void>
  readonly read: () => Promise<OnDeviceTtsChannelRead>
}

export type OnDeviceTtsChannelRead = {
  readonly revision: number
  readonly status: OnDeviceTtsChannelStatus
  readonly reason: OnDeviceTtsFailure | null
}

export type OnDeviceTtsChannelStatus =
  | 'idle'
  | 'speaking'
  | 'done'
  | 'stopped'
  | 'interrupted'
  | 'failed'

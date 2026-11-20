import { useCallback, useEffect, useRef, useState } from 'react'
import { useDictationCapture } from '../platform/audio-capture/dictation-capture'
import { nativeMicrophoneScreenLock } from '../platform/audio-capture/native-audio-device'
import { useOnDeviceSpeech } from '../platform/speech/on-device-speech'
import { loadVoiceModeResponseDelaySeconds } from '../storage/voice-mode-settings'
import { voiceModeCopy } from './voice-mode-copy'
import { VoiceLoopShell, type VoiceLoopSendOutcome, type VoiceLoopView } from './voice-loop-shell'

// How long a send may wait for its turn to start before the loop resumes listening.
const TURN_START_GRACE_MS = 10_000
const TURN_SETTLE_POLL_MS = 250

const IDLE_VIEW: VoiceLoopView = { route: 'idle', transcript: '', pending: null, reply: null }

export type MobileSessionVoiceMode = {
  view: VoiceLoopView
  entryAvailable: boolean
  start: () => void
  tapPending: () => void
  exit: () => void
}

/** The chat seams the loop rides: sending, the running turn, and the chat's visibility. */
export type VoiceModeChatSeam = {
  handleNativeChatSend: (text: string, images?: string[]) => Promise<boolean>
  nativeChatTurnActive: boolean
  showNativeChat: boolean
}

/** The app's own dictation holds the microphone exclusively while any of these is true. */
export type VoiceModeMicState = {
  isStarting: boolean
  isRecording: boolean
  isProcessing: boolean
}

// The session screen's side of voice mode: one loop over the chat's send seam, left when the chat hides.
export function useMobileSessionVoiceMode(
  showToast: (message: string) => void,
  chat: VoiceModeChatSeam,
  mic: VoiceModeMicState
): MobileSessionVoiceMode {
  const speech = useOnDeviceSpeech()
  const capture = useDictationCapture()
  const [view, setView] = useState<VoiceLoopView>(IDLE_VIEW)
  const [shell, setShell] = useState<VoiceLoopShell | null>(null)
  const shellRef = useRef<VoiceLoopShell | null>(null)
  const speechRef = useRef(speech)
  const captureRef = useRef(capture)
  const sendChatRef = useRef((text: string) => chat.handleNativeChatSend(text))
  const turnActiveRef = useRef(chat.nativeChatTurnActive)
  const micBusyRef = useRef(mic.isStarting || mic.isRecording || mic.isProcessing)
  const delaySecondsRef = useRef(1.5)
  // Reply polls outlive their shell only if the loop exits mid-wait; they stop with the loop.
  const replyPollersRef = useRef(new Set<ReturnType<typeof setInterval>>())

  useEffect(() => {
    speechRef.current = speech
    captureRef.current = capture
    sendChatRef.current = (text: string) => chat.handleNativeChatSend(text)
    turnActiveRef.current = chat.nativeChatTurnActive
    micBusyRef.current = mic.isStarting || mic.isRecording || mic.isProcessing
  }, [speech, capture, chat, mic])

  useEffect(() => {
    void loadVoiceModeResponseDelaySeconds().then((seconds) => {
      delaySecondsRef.current = seconds
    })
  }, [])

  // The reply renders in the chat behind the overlay: wait out the turn the send started.
  const awaitReply = (): Promise<string> =>
    new Promise((resolve) => {
      let sawActive = turnActiveRef.current
      const startedAt = Date.now()
      const poller = setInterval(() => {
        if (turnActiveRef.current) {
          sawActive = true
          return
        }
        if (sawActive || Date.now() - startedAt > TURN_START_GRACE_MS) {
          clearInterval(poller)
          replyPollersRef.current.delete(poller)
          resolve('')
        }
      }, TURN_SETTLE_POLL_MS)
      replyPollersRef.current.add(poller)
    })

  const start = useCallback(() => {
    if (shellRef.current !== null) {
      return
    }
    if (speechRef.current === null) {
      showToast(voiceModeCopy.notice('mic-unavailable'))
      return
    }
    const next = new VoiceLoopShell({
      now: Date.now,
      // The phone's own dictation holds the microphone while it runs; that hold is exclusive.
      startSpeech: async () => {
        if (micBusyRef.current) {
          return { started: false, busy: true }
        }
        const started = await speechRef.current!.start()
        return started.started
          ? { started: true, busy: false }
          : { started: false, busy: started.reason === 'busy' }
      },
      cancelSpeech: () => speechRef.current?.cancel(),
      readSpeech: () => speechRef.current!.read(),
      openMic: async () => {
        const opened = await captureRef.current.open()
        if (!opened.ok) {
          return false
        }
        if (!captureRef.current.begin()) {
          void captureRef.current.end()
          return false
        }
        return true
      },
      closeMic: () => {
        try {
          void captureRef.current.end()
        } catch (err) {
          // Cleanup must keep going when a synchronous seam throws, or the mic would leak.
          console.error('Failed to close the voice-mode microphone', err)
        }
      },
      holdScreen: () => nativeMicrophoneScreenLock.hold(),
      releaseScreen: () => nativeMicrophoneScreenLock.release(),
      send: async (text): Promise<VoiceLoopSendOutcome> => {
        const accepted = await sendChatRef.current(text)
        if (!accepted) {
          return { sent: false }
        }
        return { sent: true, reply: await awaitReply() }
      },
      responseDelayMs: () => delaySecondsRef.current * 1000,
      onState: setView,
      onNotice: (notice) => showToast(voiceModeCopy.notice(notice))
    })
    shellRef.current = next
    setShell(next)
    void next.start()
  }, [showToast])

  const tapPending = useCallback(() => shellRef.current?.tapPending(), [])
  const exit = useCallback(() => shellRef.current?.exit(), [])

  // Leaving the chat tab ends the loop; the machine settles and the mic and screen release.
  useEffect(() => {
    if (shellRef.current !== null && !chat.showNativeChat) {
      shellRef.current.exit()
    }
  }, [chat.showNativeChat])

  // A closed loop is dropped so the next long press starts a fresh one; nothing of it may leak.
  useEffect(() => {
    if (shell !== null && view.route === 'closed') {
      shell.dispose()
      shellRef.current = null
      setShell(null)
    }
  }, [shell, view.route])

  useEffect(() => {
    return () => {
      shellRef.current?.dispose()
      shellRef.current = null
      for (const poller of replyPollersRef.current) {
        clearInterval(poller)
      }
      replyPollersRef.current.clear()
    }
  }, [])

  return {
    view,
    entryAvailable: speech !== null,
    start,
    tapPending,
    exit
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { useDictationCapture } from '../platform/audio-capture/dictation-capture'
import type { DictationCaptureOpen } from '../platform/audio-capture/dictation-capture-contract'
import { nativeMicrophoneScreenLock } from '../platform/audio-capture/native-audio-device'
import { useOnDeviceSpeech } from '../platform/speech/on-device-speech'
import { useMobileDictationHost } from '../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { loadVoiceModeResponseDelaySeconds } from '../storage/voice-mode-settings'
import { voiceModeCopy } from './voice-mode-copy'
import { VoiceLoopShell } from './voice-loop-shell'
import type { VoiceLoopSendOutcome, VoiceLoopView } from './voice-loop-shell-contract'

// How long a send may wait for its turn to start before the loop resumes listening.
const TURN_START_GRACE_MS = 10_000
// A turn that never settles must not hold the loop in thinking forever.
const TURN_SETTLE_TIMEOUT_MS = 10 * 60_000
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

// One recognizer per phone: busy while the page's dictation is starting, recording or finishing.
function dictationHoldsRecognizer(dictation: UseMobileDictationResult): boolean {
  return dictation.isStarting || dictation.isRecording || dictation.isProcessing
}

// A reply poll stops when its turn settles; this clears and settles every live poll at once.
type ReplyWait = {
  readonly settle: () => void
}

// The session screen's side of voice mode: one loop over the chat's send seam, left when the chat hides.
export function useMobileSessionVoiceMode(
  showToast: (message: string) => void,
  chat: VoiceModeChatSeam
): MobileSessionVoiceMode {
  const speech = useOnDeviceSpeech()
  const capture = useDictationCapture()
  const dictationHost = useMobileDictationHost()
  const [view, setView] = useState<VoiceLoopView>(IDLE_VIEW)
  const [shell, setShell] = useState<VoiceLoopShell | null>(null)
  const shellRef = useRef<VoiceLoopShell | null>(null)
  const speechRef = useRef(speech)
  const captureRef = useRef(capture)
  const sendChatRef = useRef((text: string) => chat.handleNativeChatSend(text))
  const turnActiveRef = useRef(chat.nativeChatTurnActive)
  const dictationHostRef = useRef(dictationHost)
  const delaySecondsRef = useRef(1.5)
  // Reply polls belong to one loop: ending the loop settles them, so no timer outlives the shell.
  const replyWaitsRef = useRef(new Set<ReplyWait>())

  useEffect(() => {
    speechRef.current = speech
    captureRef.current = capture
    sendChatRef.current = (text: string) => chat.handleNativeChatSend(text)
    turnActiveRef.current = chat.nativeChatTurnActive
    dictationHostRef.current = dictationHost
  }, [speech, capture, chat, dictationHost])

  useEffect(() => {
    void loadVoiceModeResponseDelaySeconds().then((seconds) => {
      delaySecondsRef.current = seconds
    })
  }, [])

  const settleReplyWaits = useCallback(() => {
    for (const wait of replyWaitsRef.current) {
      wait.settle()
    }
  }, [])

  // The reply renders in the chat behind the overlay: wait out the turn the send started.
  const awaitReply = (owner: VoiceLoopShell): Promise<string> =>
    new Promise((resolve) => {
      let sawActive = turnActiveRef.current
      const startedAt = Date.now()
      const settle = () => {
        clearInterval(poller)
        replyWaitsRef.current.delete(wait)
        resolve('')
      }
      const wait: ReplyWait = { settle }
      const poller = setInterval(() => {
        // The loop that asked is gone; nothing of its turn is worth waiting for.
        if (shellRef.current !== owner) {
          settle()
          return
        }
        if (!turnActiveRef.current && (sawActive || Date.now() - startedAt > TURN_START_GRACE_MS)) {
          settle()
          return
        }
        if (turnActiveRef.current) {
          sawActive = true
        }
        if (Date.now() - startedAt > TURN_SETTLE_TIMEOUT_MS) {
          settle()
        }
      }, TURN_SETTLE_POLL_MS)
      replyWaitsRef.current.add(wait)
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
      // The page's dictation holds the recognizer wherever it started; voice mode refuses it, never steals it.
      startSpeech: async () => {
        if (dictationHoldsRecognizer(dictationHostRef.current.getDictation())) {
          return { started: false, busy: true }
        }
        try {
          const started = await speechRef.current!.start()
          return started.started
            ? { started: true, busy: false }
            : { started: false, busy: started.reason === 'busy' }
        } catch {
          // A bridge refusal rejects; a start that cannot even ask reports unavailable, not busy.
          return { started: false, busy: false }
        }
      },
      cancelSpeech: () => speechRef.current?.cancel(),
      readSpeech: () => speechRef.current!.read(),
      openMic: async () => {
        let opened: DictationCaptureOpen
        try {
          opened = await captureRef.current.open()
        } catch {
          // The capture contract lets a bridge refusal reject; that is a refused open here.
          return false
        }
        if (!opened.ok) {
          return false
        }
        try {
          if (!captureRef.current.begin()) {
            void captureRef.current.end()
            return false
          }
        } catch {
          // Native recording can throw part-way; treat it like a refused begin so the microphone is released.
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
        return { sent: true, reply: await awaitReply(next) }
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
  const exit = useCallback(() => {
    shellRef.current?.exit()
    settleReplyWaits()
  }, [settleReplyWaits])

  // Leaving the chat tab ends the loop; the machine settles and the mic and screen release.
  useEffect(() => {
    if (shellRef.current !== null && !chat.showNativeChat) {
      exit()
    }
  }, [chat.showNativeChat, exit])

  // A closed loop is dropped so the next long press starts a fresh one; nothing of it may leak.
  useEffect(() => {
    if (shell !== null && view.route === 'closed') {
      shell.dispose()
      shellRef.current = null
      setShell(null)
      settleReplyWaits()
    }
  }, [shell, view.route, settleReplyWaits])

  useEffect(() => {
    return () => {
      shellRef.current?.dispose()
      shellRef.current = null
      settleReplyWaits()
    }
  }, [settleReplyWaits])

  return {
    view,
    entryAvailable: speech !== null,
    start,
    tapPending,
    exit
  }
}

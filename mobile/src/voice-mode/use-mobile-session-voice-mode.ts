import { useCallback, useEffect, useRef, useState } from 'react'
import { useDictationCapture } from '../platform/audio-capture/dictation-capture'
import type { DictationCaptureOpen } from '../platform/audio-capture/dictation-capture-contract'
import { nativeMicrophoneScreenLock } from '../platform/audio-capture/native-audio-device'
import { useOnDeviceSpeech } from '../platform/speech/on-device-speech'
import { useOnDeviceTts } from '../platform/tts/on-device-tts'
import { useMobileDictationHost } from '../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import {
  loadVoiceModeBargeIn,
  loadVoiceModeFallbackReadout,
  loadVoiceModeResponseDelaySeconds
} from '../storage/voice-mode-settings'
import { voiceModeCopy } from './voice-mode-copy'
import { createVoiceReadout } from './voice-readout'
import type { VoiceReadout, VoiceSpeakBroadcast } from './voice-readout-contract'
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
  stopSpeaking: () => void
  exit: () => void
}

/** The chat seams the loop rides: sending, steering the running turn, the chat's visibility, its latest reply, the host's speak broadcasts, and which conversation the loop speaks for. */
export type VoiceModeChatSeam = {
  handleNativeChatSend: (text: string, images?: string[]) => Promise<boolean>
  /** Reroutes the running turn with a mid-turn utterance; false reports the chat refused it. */
  steer: (text: string) => Promise<{ steered: boolean }>
  nativeChatTurnActive: boolean
  showNativeChat: boolean
  /** The host's speak broadcasts, the same notifications stream the push path reads. */
  subscribeSpeakBroadcasts: (onBroadcast: (broadcast: VoiceSpeakBroadcast) => void) => () => void
  /** The chat's latest reply text, sampled when a turn settles. */
  latestReplyText: () => string
  /** The active conversation's structured agent-session id — the same id the host names on its speak broadcasts; null when no conversation resolves. */
  activeSessionId: () => string | null
}

// One recognizer per phone: busy while the page's dictation is starting, recording or finishing.
function dictationHoldsRecognizer(dictation: UseMobileDictationResult): boolean {
  return dictation.isStarting || dictation.isRecording || dictation.isProcessing
}

// A reply poll stops when its turn settles; this clears and settles every live poll at once.
type ReplyWait = {
  readonly settle: () => void
}

// The session gate for speak broadcasts. The host names each broadcast with the structured
// agent-session id and the phone's agent-session tab carries that same id, so a named session that
// is not the active conversation's id is another conversation's briefing: dropped before the
// readout, which stays session-agnostic per its contract. A null session is the host's unaddressed
// broadcast — with no name nothing can mismatch — so it stays audible whichever conversation, if
// any, is active.
function briefingAddressesActiveSession(
  broadcast: VoiceSpeakBroadcast,
  activeSessionId: () => string | null
): boolean {
  if (broadcast.session === null) {
    return true
  }
  return activeSessionId() === broadcast.session
}

// The session screen's side of voice mode: one loop over the chat's send seam, left when the chat hides.
export function useMobileSessionVoiceMode(
  showToast: (message: string) => void,
  chat: VoiceModeChatSeam
): MobileSessionVoiceMode {
  const speech = useOnDeviceSpeech()
  const tts = useOnDeviceTts()
  const capture = useDictationCapture()
  const dictationHost = useMobileDictationHost()
  const [view, setView] = useState<VoiceLoopView>(IDLE_VIEW)
  const [shell, setShell] = useState<VoiceLoopShell | null>(null)
  const shellRef = useRef<VoiceLoopShell | null>(null)
  const speechRef = useRef(speech)
  const ttsRef = useRef(tts)
  const captureRef = useRef(capture)
  const sendChatRef = useRef((text: string) => chat.handleNativeChatSend(text))
  const steerChatRef = useRef((text: string) => chat.steer(text))
  const turnActiveRef = useRef(chat.nativeChatTurnActive)
  const dictationHostRef = useRef(dictationHost)
  const delaySecondsRef = useRef(1.5)
  const chatVisibleRef = useRef(chat.showNativeChat)
  // The loop the entry is still loading settings for; a second entry in that window must not stack.
  const startingLoopRef = useRef(false)
  const mountedRef = useRef(true)
  const latestReplyTextRef = useRef<() => string>(() => '')
  const activeSessionIdRef = useRef<() => string | null>(() => null)
  const subscribeSpeakRef = useRef<(typeof chat)['subscribeSpeakBroadcasts']>(() => () => undefined)
  // The loop's one playback owner; its broadcasts land here while the loop runs.
  const readoutRef = useRef<VoiceReadout | null>(null)
  const unsubscribeSpeakRef = useRef<(() => void) | null>(null)
  // Reply polls belong to one loop: ending the loop settles them, so no timer outlives the shell.
  const replyWaitsRef = useRef(new Set<ReplyWait>())

  useEffect(() => {
    speechRef.current = speech
    ttsRef.current = tts
    captureRef.current = capture
    sendChatRef.current = (text: string) => chat.handleNativeChatSend(text)
    steerChatRef.current = (text: string) => chat.steer(text)
    turnActiveRef.current = chat.nativeChatTurnActive
    dictationHostRef.current = dictationHost
    latestReplyTextRef.current = chat.latestReplyText
    activeSessionIdRef.current = chat.activeSessionId
    subscribeSpeakRef.current = chat.subscribeSpeakBroadcasts
    chatVisibleRef.current = chat.showNativeChat
  }, [speech, tts, capture, chat, dictationHost])

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

  const stopSpeakSubscription = useCallback(() => {
    unsubscribeSpeakRef.current?.()
    unsubscribeSpeakRef.current = null
  }, [])

  // The reply renders in the chat behind the overlay: wait out the turn the send started, then
  // hold its latest text out for the readout to speak.
  const awaitReply = (owner: VoiceLoopShell): Promise<string> =>
    new Promise((resolve) => {
      let sawActive = turnActiveRef.current
      const startedAt = Date.now()
      const settle = () => {
        clearInterval(poller)
        replyWaitsRef.current.delete(wait)
        resolve(latestReplyTextRef.current())
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
    if (shellRef.current !== null || startingLoopRef.current) {
      return
    }
    if (speechRef.current === null) {
      showToast(voiceModeCopy.notice('mic-unavailable'))
      return
    }
    startingLoopRef.current = true
    void (async () => {
      // Each loop loads the persisted speaking toggles as it starts — not at the hook's mount — so a
      // save made since the last loop, or one this phone had not read yet, is in force for this one.
      // The loads answer unreadable storage with the defaults instead of rejecting, so this always runs.
      const [bargeIn, fallbackReadout] = await Promise.all([
        loadVoiceModeBargeIn(),
        loadVoiceModeFallbackReadout()
      ])
      startingLoopRef.current = false
      // The chat hid or the hook unmounted while the settings loaded; no loop may begin after either.
      if (!mountedRef.current || !chatVisibleRef.current) {
        return
      }
      // The speaking side's single owner for this loop; a shell without the tts verb stays silent, never broken.
      const readout = createVoiceReadout({ playback: ttsRef.current })
      readoutRef.current = readout
      unsubscribeSpeakRef.current = subscribeSpeakRef.current((broadcast) => {
        // The session gate wraps briefingArrived here, never inside the readout: playback
        // ownership is untouched by a dropped broadcast, which simply never becomes a briefing.
        if (briefingAddressesActiveSession(broadcast, activeSessionIdRef.current)) {
          readoutRef.current?.briefingArrived(broadcast)
        }
      })
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
        readout,
        // Both toggles are fixed for this loop's life: a change applies to the loop after this one.
        bargeIn,
        fallbackReadout,
        send: async (text): Promise<VoiceLoopSendOutcome> => {
          const accepted = await sendChatRef.current(text)
          if (!accepted) {
            return { sent: false }
          }
          return { sent: true, reply: await awaitReply(next) }
        },
        // A mid-turn utterance reroutes the turn the send started; idle speech still only ever sends.
        steer: (text) => steerChatRef.current(text),
        responseDelayMs: () => delaySecondsRef.current * 1000,
        onState: setView,
        onNotice: (notice) => showToast(voiceModeCopy.notice(notice))
      })
      shellRef.current = next
      setShell(next)
      void next.start()
    })()
  }, [showToast])

  const tapPending = useCallback(() => shellRef.current?.tapPending(), [])
  const stopSpeaking = useCallback(() => shellRef.current?.stopSpeaking(), [])
  const exit = useCallback(() => {
    shellRef.current?.exit()
    settleReplyWaits()
    stopSpeakSubscription()
  }, [settleReplyWaits, stopSpeakSubscription])

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
      stopSpeakSubscription()
    }
  }, [shell, view.route, settleReplyWaits, stopSpeakSubscription])

  useEffect(() => {
    // A remount (StrictMode runs this twice) is live again; only a real teardown ends entry for good.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      shellRef.current?.dispose()
      shellRef.current = null
      settleReplyWaits()
      stopSpeakSubscription()
    }
  }, [settleReplyWaits, stopSpeakSubscription])

  return {
    view,
    entryAvailable: speech !== null,
    start,
    tapPending,
    stopSpeaking,
    exit
  }
}

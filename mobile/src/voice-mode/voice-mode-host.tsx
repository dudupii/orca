import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useDictationCapture } from '../platform/audio-capture/dictation-capture'
import type { DictationCaptureOpen } from '../platform/audio-capture/dictation-capture-contract'
import { nativeMicrophoneScreenLock } from '../platform/audio-capture/native-audio-device'
import { useOnDeviceSpeech } from '../platform/speech/on-device-speech'
import { useOnDeviceTts } from '../platform/tts/on-device-tts'
import { useMobileDictationHost } from '../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { useRouteHandoff } from '../navigation/route-handoff'
import {
  loadVoiceModeBargeIn,
  loadVoiceModeFallbackReadout,
  loadVoiceModeResponseDelaySeconds
} from '../storage/voice-mode-settings'
import { voiceModeCopy } from './voice-mode-copy'
import { createVoiceReadout } from './voice-readout'
import type { VoiceReadout } from './voice-readout-contract'
import { subscribeToSpeakBroadcasts } from './speak-broadcast'
import { VoiceLoopShell } from './voice-loop-shell'
import type { VoiceLoopSendOutcome, VoiceLoopView } from './voice-loop-shell-contract'
import {
  MobileVoiceModeHostContext,
  type MobileVoiceModeChatBinding,
  type MobileVoiceModeHost,
  type MobileVoiceModeLive,
  type MobileVoiceModeOwner,
  type MobileVoiceModeScreen
} from './voice-mode-host-context'

export { useMobileVoiceModeHost } from './voice-mode-host-context'

// How long a send may wait for its turn to start before the loop resumes listening.
const TURN_START_GRACE_MS = 10_000
// A turn that never settles must not hold the loop in thinking forever.
const TURN_SETTLE_TIMEOUT_MS = 10 * 60_000
const TURN_SETTLE_POLL_MS = 250

const IDLE_VIEW: VoiceLoopView = { route: 'idle', transcript: '', pending: null, reply: null }

// One recognizer per phone: busy while the page's dictation is starting, recording or finishing.
function dictationHoldsRecognizer(dictation: UseMobileDictationResult): boolean {
  return dictation.isStarting || dictation.isRecording || dictation.isProcessing
}

// The screen standing for the chat: the one in front of the owner's session, else its newest
// copy; before any loop exists, whatever screen is in front — the one that just pressed the mic.
function screenFor(
  screens: ReadonlySet<MobileVoiceModeScreen>,
  owner: MobileVoiceModeOwner | null
): MobileVoiceModeScreen | null {
  const matches = [...screens].filter(
    (screen) => owner === null || screen.sessionKey === owner.sessionKey
  )
  return matches.find((screen) => screen.shown()) ?? matches.at(-1) ?? null
}

// A reply poll stops when its turn settles; this clears and settles every live poll at once. An
// unbound pause freezes its clocks instead of settling it against the chat's frozen answers.
type ReplyWait = {
  readonly settle: () => void
  readonly setSeam: (bound: boolean) => void
}

/**
 * The page's one voice loop, above its screens, so it keeps going when its session leaves the
 * screen: the loop's platform side, its settings loads and its speak-broadcast subscription live
 * here, while each mounted session screen binds its chat's seam for as long as it stands. With no
 * seam bound the loop holds its words (the shell's commit stage stays un-armed) and pauses its
 * reply polls; a rebound seam re-arms the one and resumes the other.
 */
export function MobileVoiceModeHostProvider({ children }: { children: ReactNode }) {
  const router = useRouteHandoff()
  const dictationHost = useMobileDictationHost()
  const speech = useOnDeviceSpeech()
  const tts = useOnDeviceTts()
  const capture = useDictationCapture()
  const [view, setView] = useState<VoiceLoopView>(IDLE_VIEW)
  const [owner, setOwner] = useState<MobileVoiceModeOwner | null>(null)
  const [shell, setShell] = useState<VoiceLoopShell | null>(null)
  const shellRef = useRef<VoiceLoopShell | null>(null)
  const ownerRef = useRef<MobileVoiceModeOwner | null>(null)
  // The loop the entry is still loading settings for; a second entry in that window must not stack.
  const startingLoopRef = useRef(false)
  const speechRef = useRef(speech)
  const ttsRef = useRef(tts)
  const captureRef = useRef(capture)
  const dictationHostRef = useRef(dictationHost)
  const delaySecondsRef = useRef(1.5)
  // The loop's one playback owner; its broadcasts land here while the loop runs.
  const readoutRef = useRef<VoiceReadout | null>(null)
  const unsubscribeSpeakRef = useRef<(() => void) | null>(null)
  const subscribedClientRef = useRef<unknown>(null)
  const replyWaitsRef = useRef(new Set<ReplyWait>())
  const screensRef = useRef(new Set<MobileVoiceModeScreen>())
  // The mounted screens' seams, last bound on top of each session; the loop rides its own session's.
  const bindingsRef = useRef<MobileVoiceModeChatBinding[]>([])

  useEffect(() => {
    speechRef.current = speech
    ttsRef.current = tts
    captureRef.current = capture
    dictationHostRef.current = dictationHost
  }, [speech, tts, capture, dictationHost])

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
    subscribedClientRef.current = null
  }, [])

  // Notices toast on the screen standing for the chat; a later piece gives the away case its pill.
  const notice = useCallback((message: string) => {
    const screen = screenFor(screensRef.current, ownerRef.current)
    if (screen?.shown()) {
      screen.toast(message)
    }
  }, [])

  // The seam standing for the loop's chat: the newest binding of its own session, never another
  // session's screen stacked over it.
  const chatBinding = useCallback((): MobileVoiceModeChatBinding | null => {
    const owner = ownerRef.current
    const bindings = bindingsRef.current
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const binding = bindings[index]!
      if (owner === null || binding.sessionKey === owner.sessionKey) {
        return binding
      }
    }
    return null
  }, [])

  // The chat seams answer together whenever the top binding changes: the reply polls resume or
  // pause, and a rebound screen's different client re-runs the loop's speak subscription.
  const bindingsChanged = useCallback(() => {
    const top = chatBinding()
    for (const wait of replyWaitsRef.current) {
      wait.setSeam(top !== null)
    }
    // The broadcasts follow the newest client the loop's session was seen on: a rebound screen's
    // fresher one when it differs, and the last one standing while no seam binds — only the loop
    // itself ending drops them.
    const client = top?.client ?? null
    if (client === null || client === subscribedClientRef.current || shellRef.current === null) {
      return
    }
    unsubscribeSpeakRef.current?.()
    subscribedClientRef.current = client
    unsubscribeSpeakRef.current = subscribeToSpeakBroadcasts(client, (broadcast) => {
      readoutRef.current?.briefingArrived(broadcast)
    })
  }, [chatBinding])

  // The reply renders in the chat behind the overlay: wait out the turn the send started, then
  // hold its latest text out for the readout to speak. An unbound pause neither settles nor
  // advances — a frozen turnActive would speak a stale reply or hang to the settle timeout.
  const awaitReply = (loop: VoiceLoopShell): Promise<string> =>
    new Promise((resolve) => {
      let sawActive = chatBinding()?.seam.turnActive() ?? false
      let startedAt = Date.now()
      let poller: ReturnType<typeof setInterval> | null = null
      let pausedAt: number | null = null
      const settle = () => {
        if (poller !== null) {
          clearInterval(poller)
        }
        replyWaitsRef.current.delete(wait)
        resolve(chatBinding()?.seam.latestReplyText() ?? '')
      }
      const poll = () => {
        // The loop that asked is gone; nothing of its turn is worth waiting for.
        if (shellRef.current !== loop) {
          settle()
          return
        }
        const turnActive = chatBinding()?.seam.turnActive() ?? false
        if (!turnActive && (sawActive || Date.now() - startedAt > TURN_START_GRACE_MS)) {
          settle()
          return
        }
        if (turnActive) {
          sawActive = true
        }
        if (Date.now() - startedAt > TURN_SETTLE_TIMEOUT_MS) {
          settle()
        }
      }
      const wait: ReplyWait = {
        settle,
        setSeam: (bound) => {
          if (bound) {
            if (poller === null && pausedAt !== null) {
              startedAt += Date.now() - pausedAt
              pausedAt = null
              poller = setInterval(poll, TURN_SETTLE_POLL_MS)
            }
            return
          }
          if (poller !== null) {
            clearInterval(poller)
            poller = null
            pausedAt = Date.now()
          }
        }
      }
      poller = setInterval(poll, TURN_SETTLE_POLL_MS)
      replyWaitsRef.current.add(wait)
    })

  const start = useCallback(
    (next: MobileVoiceModeOwner) => {
      if (shellRef.current !== null || startingLoopRef.current) {
        return
      }
      if (speechRef.current === null) {
        notice(voiceModeCopy.notice('mic-unavailable'))
        return
      }
      startingLoopRef.current = true
      void (async () => {
        // Each loop loads the persisted speaking toggles as it starts — not at the host's mount —
        // so a save made since the last loop, or one this phone had not read yet, is in force for
        // this one. The loads answer unreadable storage with the defaults instead of rejecting.
        const [bargeIn, fallbackReadout] = await Promise.all([
          loadVoiceModeBargeIn(),
          loadVoiceModeFallbackReadout()
        ])
        startingLoopRef.current = false
        // The starting screen left while the settings loaded; no loop may begin after it.
        if (!bindingsRef.current.some((binding) => binding.sessionKey === next.sessionKey)) {
          return
        }
        // The speaking side's single owner for this loop; a shell without the tts verb stays silent, never broken.
        const readout = createVoiceReadout({ playback: ttsRef.current })
        readoutRef.current = readout
        if (next.client !== null) {
          subscribedClientRef.current = next.client
          unsubscribeSpeakRef.current = subscribeToSpeakBroadcasts(next.client, (broadcast) => {
            readoutRef.current?.briefingArrived(broadcast)
          })
        }
        const loop = new VoiceLoopShell({
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
          // No seam stands for the chat while every screen is gone: the words hold for the rebind.
          chatBound: () => chatBinding() !== null,
          send: async (text): Promise<VoiceLoopSendOutcome> => {
            const seam = chatBinding()?.seam
            if (!seam) {
              return { sent: false }
            }
            const accepted = await seam.send(text)
            if (!accepted) {
              return { sent: false }
            }
            return { sent: true, reply: await awaitReply(loop) }
          },
          // A mid-turn utterance reroutes the turn the send started; idle speech still only ever sends.
          steer: (text) => chatBinding()?.seam.steer(text) ?? Promise.resolve({ steered: false }),
          responseDelayMs: () => delaySecondsRef.current * 1000,
          onState: setView,
          onNotice: (noticed) => notice(voiceModeCopy.notice(noticed))
        })
        shellRef.current = loop
        ownerRef.current = next
        setShell(loop)
        setOwner(next)
        void loop.start()
      })()
    },
    [notice, chatBinding]
  )

  const exit = useCallback(() => {
    shellRef.current?.exit()
    settleReplyWaits()
    stopSpeakSubscription()
  }, [settleReplyWaits, stopSpeakSubscription])

  // A closed loop is dropped so the next long press starts a fresh one; nothing of it may leak.
  useEffect(() => {
    if (shell !== null && view.route === 'closed') {
      shell.dispose()
      shellRef.current = null
      ownerRef.current = null
      setShell(null)
      setOwner(null)
      settleReplyWaits()
      stopSpeakSubscription()
    }
  }, [shell, view.route, settleReplyWaits, stopSpeakSubscription])

  // The page itself going away ends the loop for good; only a real teardown may do that.
  useEffect(
    () => () => {
      shellRef.current?.dispose()
      shellRef.current = null
      ownerRef.current = null
      settleReplyWaits()
      stopSpeakSubscription()
    },
    [settleReplyWaits, stopSpeakSubscription]
  )

  const attachScreen = useCallback((screen: MobileVoiceModeScreen) => {
    screensRef.current.add(screen)
    return () => {
      screensRef.current.delete(screen)
    }
  }, [])

  const bindChat = useCallback(
    (binding: MobileVoiceModeChatBinding) => {
      bindingsRef.current = [...bindingsRef.current, binding]
      bindingsChanged()
      return () => {
        bindingsRef.current = bindingsRef.current.filter((held) => held !== binding)
        bindingsChanged()
      }
    },
    [bindingsChanged]
  )

  // Bring the loop's chat back: its screen if one is still mounted, otherwise open the session again.
  const open = useCallback(() => {
    const current = ownerRef.current
    if (!current) {
      return
    }
    const screen = screenFor(screensRef.current, current)
    if (screen) {
      screen.bringToFront(current.paneKey)
    } else {
      router.push(current.href)
    }
  }, [router])

  // Screens subscribe to the live loop; the host's context only changes when its view, owner or entry does.
  const listenersRef = useRef(new Set<() => void>())
  const live = useMemo<MobileVoiceModeLive>(
    () => ({ view, owner, entryAvailable: speech !== null }),
    [view, owner, speech]
  )
  const liveRef = useRef(live)
  useLayoutEffect(() => {
    liveRef.current = live
    for (const listener of listenersRef.current) {
      listener()
    }
  })
  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])
  const getLive = useCallback(() => liveRef.current, [])

  const value = useMemo<MobileVoiceModeHost>(
    () => ({
      start,
      exit,
      tapPending: () => shellRef.current?.tapPending(),
      stopSpeaking: () => shellRef.current?.stopSpeaking(),
      attachScreen,
      bindChat,
      subscribe,
      getLive,
      open
    }),
    [start, exit, attachScreen, bindChat, subscribe, getLive, open]
  )
  return (
    <MobileVoiceModeHostContext.Provider value={value}>
      {children}
    </MobileVoiceModeHostContext.Provider>
  )
}

/** Where the persistent voice pill will mount, once its piece draws it; empty until then. */
export function MobileVoiceModePillLayer(): null {
  return null
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { AppState } from 'react-native'
import { useDictationCapture } from '../platform/audio-capture/dictation-capture'
import type { DictationCaptureOpen } from '../platform/audio-capture/dictation-capture-contract'
import { nativeMicrophoneScreenLock } from '../platform/audio-capture/native-audio-device'
import { useOnDeviceSpeech } from '../platform/speech/on-device-speech'
import { useOnDeviceTone } from '../platform/tone/on-device-tone'
import { useOnDeviceTts } from '../platform/tts/on-device-tts'
import { useMobileDictationHost } from '../dictation/mobile-dictation-host-context'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { useRouteHandoff } from '../navigation/route-handoff'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
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
  VoiceModeOwnerLiveness,
  VOICE_MODE_OWNER_LIVENESS_POLL_MS
} from './voice-mode-owner-liveness'
import {
  MobileVoiceModeHostContext,
  MobileVoiceModePillContext,
  type MobileVoiceModeChatBinding,
  type MobileVoiceModeHost,
  type MobileVoiceModeLive,
  type MobileVoiceModeOwner,
  type MobileVoiceModePill,
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
  /** The poll's answer, settled when the turn does; awaiting it is safe whenever the send resolves. */
  readonly done: () => Promise<string>
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
  const tone = useOnDeviceTone()
  const capture = useDictationCapture()
  const [view, setView] = useState<VoiceLoopView>(IDLE_VIEW)
  const [owner, setOwner] = useState<MobileVoiceModeOwner | null>(null)
  const [shell, setShell] = useState<VoiceLoopShell | null>(null)
  const [, setRevision] = useState(0)
  const [awayToast, setAwayToast] = useState<string | null>(null)
  const shellRef = useRef<VoiceLoopShell | null>(null)
  const ownerRef = useRef<MobileVoiceModeOwner | null>(null)
  // The loop the entry is still loading settings for; a second entry in that window must not stack.
  const startingLoopRef = useRef(false)
  const speechRef = useRef(speech)
  const ttsRef = useRef(tts)
  const captureRef = useRef(capture)
  const dictationHostRef = useRef(dictationHost)
  const toneRef = useRef(tone)
  const delaySecondsRef = useRef(1.5)
  // The loop's one playback owner; its broadcasts land here while the loop runs.
  const readoutRef = useRef<VoiceReadout | null>(null)
  const unsubscribeSpeakRef = useRef<(() => void) | null>(null)
  const subscribedClientRef = useRef<unknown>(null)
  const replyWaitsRef = useRef(new Set<ReplyWait>())
  // The newest client the loop's session was seen on, held across the unbound stretch.
  const newestClientRef = useRef<RpcClient | null>(null)
  const screensRef = useRef(new Set<MobileVoiceModeScreen>())
  // The mounted screens' seams, last bound on top of each session; the loop rides its own session's.
  const bindingsRef = useRef<MobileVoiceModeChatBinding[]>([])

  useEffect(() => {
    speechRef.current = speech
    ttsRef.current = tts
    captureRef.current = capture
    dictationHostRef.current = dictationHost
    toneRef.current = tone
  }, [speech, tts, capture, dictationHost, tone])

  // The app's own comings and goings pause and resume the loop. Change events only — Android also
  // fires blur and focus for the app's own sheets, and an in-app sheet must never pause the voice.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      shellRef.current?.setForeground(state === 'active')
    })
    return () => subscription.remove()
  }, [])

  // The pill's answers (a screen standing, its chat shown) live in refs the screens move; a
  // revision re-renders the host so the pill reads them where they stand.
  const refresh = useCallback(() => setRevision((revision) => revision + 1), [])
  const clearAwayToast = useCallback(() => setAwayToast(null), [])

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

  // Notices toast on the screen standing for the chat; with none shown, the pill layer carries
  // them as its own transient toast, so a loop left away still says what happened to it.
  const notice = useCallback((message: string) => {
    const screen = screenFor(screensRef.current, ownerRef.current)
    if (screen?.shown()) {
      screen.toast(message)
      return
    }
    setAwayToast(message)
  }, [])

  // The seam standing for the loop's chat: the binding of its own session that started it, else
  // that session's newest — never another session's screen stacked over it. Every screen of the
  // session serves the same captured identity, so whichever stands carries the loop's words; with
  // none standing none answers, and the words hold for a screen that does.
  const chatBinding = useCallback((): MobileVoiceModeChatBinding | null => {
    const owner = ownerRef.current
    const bindings = bindingsRef.current
    if (owner === null) {
      return bindings.at(-1) ?? null
    }
    const own = bindings.filter((binding) => binding.sessionKey === owner.sessionKey)
    return own.find((binding) => binding.instance === owner.instance) ?? own.at(-1) ?? null
  }, [])

  // The chat seams answer together whenever the top binding changes: the reply polls resume or
  // pause, and a rebound screen's different client re-runs the loop's speak subscription.
  const bindingsChanged = useCallback(() => {
    const top = chatBinding()
    for (const wait of replyWaitsRef.current) {
      wait.setSeam(top !== null)
    }
    // The newest client the loop's session was seen on also carries its liveness probes, held while
    // no seam binds so the watch keeps its wire across the unbound stretch.
    if (top?.client != null) {
      newestClientRef.current = top.client
    }
    // The broadcasts follow that client: a rebound screen's fresher one when it differs, and the
    // last one standing while no seam binds — only the loop itself ending drops them.
    const client = top?.client ?? null
    if (client === null || client === subscribedClientRef.current || shellRef.current === null) {
      return
    }
    unsubscribeSpeakRef.current?.()
    subscribedClientRef.current = client
    unsubscribeSpeakRef.current = subscribeToSpeakBroadcasts(client, (broadcast) => {
      // The speak contract's session gate: a broadcast naming a session is another conversation's
      // briefing unless it names the chat this loop captured at its start. An unaddressed broadcast
      // names no one and stays audible — the readout itself stays session-agnostic per its contract.
      const ownerSession = ownerRef.current?.chat?.sessionId ?? null
      if (broadcast.session !== null && broadcast.session !== ownerSession) {
        return
      }
      readoutRef.current?.briefingArrived(broadcast)
    })
  }, [chatBinding])

  // The reply renders in the chat behind the overlay: wait out the turn the send started, then
  // hold its latest text out for the readout to speak. The wait is registered before its send
  // awaits, so an unbind while that send is still pending reaches it — a wait created only after
  // the send resolved could never have seen the transition, and its clocks would run unbeknownst
  // through the unbound stretch. An unbound pause neither settles nor advances: a frozen
  // turnActive would speak a stale reply or hang to the settle timeout.
  const startReplyWait = (loop: VoiceLoopShell): ReplyWait => {
    let resolveReply!: (text: string) => void
    const reply = new Promise<string>((resolve) => {
      resolveReply = resolve
    })
    let sawActive = chatBinding()?.seam.turnActive() ?? false
    let startedAt = Date.now()
    let poller: ReturnType<typeof setInterval> | null = null
    let pausedAt: number | null = null
    const settle = () => {
      if (poller !== null) {
        clearInterval(poller)
      }
      replyWaitsRef.current.delete(wait)
      resolveReply(chatBinding()?.seam.latestReplyText() ?? '')
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
      },
      done: () => reply
    }
    // The send that starts this wait is already bound — its own guard read the seam — so the poll
    // runs from the send's start; only the seam leaving can pause it.
    poller = setInterval(poll, TURN_SETTLE_POLL_MS)
    replyWaitsRef.current.add(wait)
    return wait
  }

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
          // The loop keeps the tone it started with; a grant that arrives mid-loop chimes from the next one.
          tone: toneRef.current,
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
            // The wait stands before the send awaits, so an unbind while the send is still pending
            // pauses its clocks through the transition; a late wait could never have seen it.
            const wait = startReplyWait(loop)
            try {
              const accepted = await seam.send(text)
              if (!accepted) {
                wait.settle()
                return { sent: false }
              }
              return { sent: true, reply: await wait.done() }
            } catch {
              // A send that rejects outright settles its wait here — nothing of its turn is left
              // to poll or pause — and reports the failure for the loop's send-failed notice.
              wait.settle()
              return { sent: false }
            }
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
        // The settings load may straddle a client change on the starting screen; the newest client
        // its session was seen on — not the one start captured — is the one the broadcasts follow.
        bindingsChanged()
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
      newestClientRef.current = null
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
      newestClientRef.current = null
      settleReplyWaits()
      stopSpeakSubscription()
    },
    [settleReplyWaits, stopSpeakSubscription]
  )

  // The loop must not outlive the pane or the worktree it runs on, and no screen of its session may
  // be left holding that watch: the page asks the host server itself, bound or not, and only answers
  // that agree twice end it — the loop ends with the screen and the microphone released.
  useEffect(() => {
    if (owner === null) {
      return
    }
    const liveness = new VoiceModeOwnerLiveness(owner)
    let stopped = false
    const probe = async () => {
      try {
        const gone = await liveness.check(
          chatBinding()?.client ?? newestClientRef.current ?? owner.client
        )
        if (!stopped && gone && ownerRef.current === owner) {
          exit()
        }
      } catch {
        // A probe that cannot even ask proves nothing; the next tick asks again.
      }
    }
    void probe()
    const interval = setInterval(() => void probe(), VOICE_MODE_OWNER_LIVENESS_POLL_MS)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [owner, exit, chatBinding])

  const attachScreen = useCallback(
    (screen: MobileVoiceModeScreen) => {
      screensRef.current.add(screen)
      refresh()
      return () => {
        screensRef.current.delete(screen)
        refresh()
      }
    },
    [refresh]
  )

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

  // The pill stands in for the chat's overlay while the loop runs and the screen standing for the
  // chat is not showing it — the same answer the notices and open() ride.
  const running =
    view.route === 'listening' || view.route === 'thinking' || view.route === 'speaking'
  const away = owner !== null && running && screenFor(screensRef.current, owner)?.shown() !== true

  // The pill's own slice, apart from the host's so a toast or a shown flip re-renders only the pill.
  const pill = useMemo<MobileVoiceModePill>(
    () => ({ away, toast: awayToast, clearToast: clearAwayToast }),
    [away, awayToast, clearAwayToast]
  )

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
      refresh,
      subscribe,
      getLive,
      open
    }),
    [start, exit, attachScreen, bindChat, refresh, subscribe, getLive, open]
  )
  return (
    <MobileVoiceModeHostContext.Provider value={value}>
      <MobileVoiceModePillContext.Provider value={pill}>
        {children}
      </MobileVoiceModePillContext.Provider>
    </MobileVoiceModeHostContext.Provider>
  )
}

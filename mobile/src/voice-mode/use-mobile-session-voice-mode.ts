import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useFocusEffect, useNavigation } from 'expo-router'
import { HOST_SESSION_ROUTE } from '../navigation/host-stack-navigation'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import { mobileSessionTabPaneKey } from '../session/tabs/notification-pane-tab'
import type { MobileSessionController } from '../session/use-mobile-session-controller'
import { mobileVoiceSessionKey, useMobileVoiceModeHost } from './voice-mode-host-context'
import type { MobileVoiceModeChatSeam } from './voice-mode-host-context'
import type { VoiceLoopView } from './voice-loop-shell-contract'

export type MobileSessionVoiceMode = {
  view: VoiceLoopView
  entryAvailable: boolean
  start: () => void
  tapPending: () => void
  stopSpeaking: () => void
  exit: () => void
}

/**
 * The session screen's side of voice mode: one loop owned by the page's host, outliving this
 * screen. While the screen stands it binds its chat's seam — sends, steering, the latest reply —
 * and registers itself as the loop's way back; unbinding holds the loop's words for the rebind.
 * The page's host watches the owner's pane and worktree, so this screen may come and go freely.
 */
export function useMobileSessionVoiceMode(
  controller: MobileSessionController
): MobileSessionVoiceMode {
  const host = useMobileVoiceModeHost()
  const { attachScreen, bindChat, refresh } = host
  const executionHost = useWorkspaceExecutionHost()
  const { hostId, worktreeId, client, showToast } = controller
  const sessionKey = mobileVoiceSessionKey(hostId, executionHost, worktreeId)
  const [instance] = useState(() => ({}))
  // The screen's own navigation: bringing it back pops what was pushed over it, never another session's screen.
  const navigation = useNavigation()
  const navigationRef = useRef(navigation)
  useLayoutEffect(() => {
    navigationRef.current = navigation
  })
  const [inFront, setInFront] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setInFront(true)
      return () => setInFront(false)
    }, [])
  )
  const live = useSyncExternalStore(host.subscribe, host.getLive)
  const owner = live.owner
  // Before any loop exists this screen is the one in front; once one does, only its session's is.
  const shown = inFront && (owner === null || owner.sessionKey === sessionKey)

  // The chat's seam, stable for the screen's life: it forwards to the controller's captured seam,
  // which the loop's captured identity mounts, so every verb rides the chat the mic was pressed on.
  const controllerRef = useRef(controller)
  useEffect(() => {
    controllerRef.current = controller
  })
  const [seam] = useState<MobileVoiceModeChatSeam>(() => ({
    send: (text: string) =>
      controllerRef.current.nativeChatController.nativeChatVoiceSeam?.send(text) ??
      Promise.resolve(false),
    // Steering rides the chat's send verb with the intent that reroutes the running turn, never queueing.
    steer: (text) =>
      controllerRef.current.nativeChatController.nativeChatVoiceSeam?.steer(text) ??
      Promise.resolve({ steered: false }),
    turnActive: () =>
      controllerRef.current.nativeChatController.nativeChatVoiceSeam?.turnActive() ?? false,
    latestReplyText: () =>
      controllerRef.current.nativeChatController.nativeChatVoiceSeam?.latestReplyText() ?? ''
  }))

  const screenRef = useRef({ shown, toast: showToast })
  useLayoutEffect(() => {
    screenRef.current = { shown, toast: showToast }
  })
  // Register the screen: the loop's notices toast through it, and its chat comes back to the front through it.
  useEffect(
    () =>
      attachScreen({
        instance,
        sessionKey,
        shown: () => screenRef.current.shown,
        bringToFront: (paneKey) => {
          const current = navigationRef.current
          // From this screen POP_TO starts at this route (the dispatch's source), so it stops here; merge keeps its params and swaps the pane.
          current?.dispatch({
            type: 'POP_TO',
            payload: {
              name: HOST_SESSION_ROUTE,
              params: paneKey ? { paneKey } : undefined,
              merge: true
            },
            target: current.getState()?.key
          })
        },
        toast: (message) => screenRef.current.toast(message)
      }),
    [attachScreen, instance, sessionKey]
  )

  // Bind the seam while this screen stands; a rebound screen's different client re-runs the loop's speak subscription.
  useEffect(
    () => bindChat({ instance, sessionKey, client, seam }),
    [bindChat, instance, sessionKey, client, seam]
  )

  // The pill reads shown() on the host's render.
  useEffect(() => refresh(), [refresh, shown])

  const start = useCallback(() => {
    const active = controllerRef.current
    const paneKey = mobileSessionTabPaneKey(active.activeSessionTab)
    host.start({
      instance,
      sessionKey,
      client: active.client,
      worktreeId,
      href: workspaceRouteHref(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}${paneKey ? `?paneKey=${encodeURIComponent(paneKey)}` : ''}`,
        executionHost
      ),
      paneKey,
      tabId: active.activeSessionTab?.id,
      title: active.activeSessionTab?.title ?? '',
      // The chat as it stands at the press: the loop's seam rides this snapshot for its whole life.
      chat: active.nativeChatController.nativeChatVoiceOwnerChat() ?? null
    })
  }, [host, instance, sessionKey, hostId, worktreeId, executionHost])

  return {
    view: live.view,
    entryAvailable: live.entryAvailable,
    start,
    tapPending: host.tapPending,
    stopSpeaking: host.stopSpeaking,
    exit: host.exit
  }
}

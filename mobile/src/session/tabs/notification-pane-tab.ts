import { makePaneKey, parsePaneKey } from '../../../../src/shared/workspace-layout/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../src/shared/agent-session/view/structured-agent-session-projection'

// The fields the pane lookup reads; session tabs and raw session-tabs replies both satisfy it.
export type PaneMatchTab = {
  readonly type: string
  readonly id: string
  readonly parentTabId?: string
  readonly leafId?: string
  readonly sessionId?: string | null
}

// Keep native/web navigation’s pane lookup separate: importing the native sibling by name on web resolves back to the web file itself.
export function notificationPaneTab<Tab extends PaneMatchTab>(
  tabs: readonly Tab[],
  paneKey: string
): Tab | undefined {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return undefined
  }
  return tabs.find((tab) =>
    tab.type === 'terminal'
      ? (tab.parentTabId ?? tab.id) === pane.tabId && tab.leafId === pane.leafId
      : tab.type === 'agent-session' &&
        (tab.id === pane.tabId ||
          (tab.sessionId !== undefined &&
            tab.sessionId !== null &&
            structuredAgentSessionPaneKey(
              structuredAgentSessionTabId(tab.sessionId),
              tab.sessionId
            ) === paneKey))
  )
}

// The pane key that opens this tab again; notificationPaneTab finds the tab from it. Session tabs
// and the looser chat tabs both carry its fields, so both can name the pane they stand on.
export type PaneKeyTab = {
  readonly type: string
  readonly id?: string
  readonly sessionId?: string | null
  readonly parentTabId?: string
  readonly leafId?: string
}

export function mobileSessionTabPaneKey(tab: PaneKeyTab | null | undefined): string | undefined {
  if (tab?.type === 'agent-session') {
    return tab.sessionId != null
      ? structuredAgentSessionPaneKey(structuredAgentSessionTabId(tab.sessionId), tab.sessionId)
      : undefined
  }
  if (tab?.type !== 'terminal' || tab.id === undefined || !tab.leafId) {
    return undefined
  }
  try {
    return makePaneKey(tab.parentTabId ?? tab.id, tab.leafId)
  } catch {
    // An id the pane key grammar refuses opens the session on its current tab instead.
    return undefined
  }
}

import { notificationPaneTab, type PaneMatchTab } from '../session/tabs/notification-pane-tab'
import { sessionTabsListRead } from '../session/tabs/mobile-session-tab-read-operations'
import { shouldBounceMissingWorktree } from '../session/use-missing-worktree-bounce'
import { sessionWorktreeRecordRead } from '../worktree/catalog/session-worktree-record-operations'
import { classifyWorktreeShowResponse } from '../worktree/navigation/worktree-show-resolution'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import type { MobileVoiceModeOwner } from './voice-mode-host-context'

// How often the page's host asks the host server whether the loop's chat still stands.
export const VOICE_MODE_OWNER_LIVENESS_POLL_MS = 5_000

// Two agreeing reads prove a removal, like the worktree bounce's confirming read: one missed answer
// is transient, and only reads that answer may prove the pane or the worktree really gone.
const PROVEN_BY_READS = 2

// The raw session-tabs reply is uninterpreted on the wire; only the fields the pane lookup reads are taken.
type SessionTabsAnswer = {
  tabs: readonly PaneMatchTab[]
  agentSessionsUnverifiable?: true
}

function readSessionTabsAnswer(reply: unknown): SessionTabsAnswer | null {
  if (reply === null || typeof reply !== 'object') {
    return null
  }
  const { tabs, agentSessionsUnverifiable } = reply as {
    tabs?: unknown
    agentSessionsUnverifiable?: unknown
  }
  if (!Array.isArray(tabs)) {
    return null
  }
  return {
    tabs: tabs as readonly PaneMatchTab[],
    agentSessionsUnverifiable: agentSessionsUnverifiable === true ? true : undefined
  }
}

/**
 * Watches the loop's chat from the page, outliving the screen that started it: its worktree and its
 * pane are asked of the host server on the loop's client, and only agreeing answers end it. Reads
 * that cannot answer — no client, no connection, a refused or unreadable reply — prove nothing and
 * keep the loop; the page's teardown stays its final disposal.
 */
export class VoiceModeOwnerLiveness {
  private readonly owner: MobileVoiceModeOwner
  private missingWorktreeReads = 0
  private missingPaneReads = 0
  private readOn: RpcClient | null = null

  constructor(owner: MobileVoiceModeOwner) {
    this.owner = owner
  }

  /** One round of reads; true only when the owner's worktree or pane is proven gone. */
  async check(client: RpcClient | null): Promise<boolean> {
    if (client === null || client.getState() !== 'connected') {
      return false
    }
    if (client !== this.readOn) {
      // A new client is a new wire; its first answer cannot confirm the last one's.
      this.readOn = client
      this.missingWorktreeReads = 0
      this.missingPaneReads = 0
    }
    const worktreeGone = await this.worktreeProvenGone(client)
    return worktreeGone || this.paneProvenGone(client)
  }

  private async worktreeProvenGone(client: RpcClient): Promise<boolean> {
    let response: RpcResponse
    try {
      response = await sessionWorktreeRecordRead.request(client, {
        worktree: `id:${this.owner.worktreeId}`
      })
    } catch {
      return this.countWorktreeRead(false)
    }
    const resolution = classifyWorktreeShowResponse(response)
    return this.countWorktreeRead(
      resolution === 'missing' && shouldBounceMissingWorktree(this.owner.worktreeId, 'missing')
    )
  }

  private async paneProvenGone(client: RpcClient): Promise<boolean> {
    const paneKey = this.owner.paneKey
    if (paneKey === undefined) {
      return false
    }
    let answer: SessionTabsAnswer | null = null
    try {
      const response = await sessionTabsListRead.request(client, {
        worktree: `id:${this.owner.worktreeId}`
      })
      answer = response.ok ? readSessionTabsAnswer(sessionTabsListRead.interpret(response)) : null
    } catch {
      answer = null
    }
    if (answer === null) {
      return this.countPaneRead(false)
    }
    // Unverifiable chat rows are preserved rather than reported gone, so their absence proves nothing.
    const paneStands =
      notificationPaneTab(answer.tabs, paneKey) !== undefined ||
      answer.agentSessionsUnverifiable === true
    return this.countPaneRead(!paneStands)
  }

  private countWorktreeRead(proven: boolean): boolean {
    this.missingWorktreeReads = proven ? this.missingWorktreeReads + 1 : 0
    return this.missingWorktreeReads >= PROVEN_BY_READS
  }

  private countPaneRead(proven: boolean): boolean {
    this.missingPaneReads = proven ? this.missingPaneReads + 1 : 0
    return this.missingPaneReads >= PROVEN_BY_READS
  }
}

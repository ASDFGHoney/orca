import type { WorkspaceSessionState } from '../../../shared/types'
import type { WorkspaceSessionSnapshot } from './workspace-session'

export function buildSanitizedTabsByWorktree(
  tabsByWorktree: WorkspaceSessionSnapshot['tabsByWorktree']
): WorkspaceSessionState['tabsByWorktree'] {
  // Why: pendingActivationSpawn is documented on TerminalTab as a transient
  // renderer-only handoff between setActiveWorktree and the next updateTabPtyId
  // — it must never be persisted. The main-process session:set handler writes
  // the payload to disk without re-parsing it against the Zod schema, so if
  // the flag were ever set and not consumed before a save (e.g. app quits
  // mid-handoff), it would round-trip to disk and the next session would
  // start with a stale suppression flag that drops the first legitimate PTY
  // spawn from the sidebar's recency sort. Strip it here to enforce the
  // type-level invariant at the persistence boundary.
  return Object.fromEntries(
    Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const { pendingActivationSpawn: _unused, ...rest } = tab
        void _unused
        return rest
      })
    ])
  )
}

export function buildTerminalSessionData(
  snapshot: WorkspaceSessionSnapshot
): Pick<WorkspaceSessionState, 'activeWorktreeIdsOnShutdown' | 'remoteSessionIdsByTabId'> {
  const tabsByWorktree = snapshot.tabsByWorktree

  // Why: ptyIdsByTabId is the live-PTY map. tab.ptyId is only a wake hint that
  // sleep intentionally preserves, so using it as liveness would revive slept
  // worktrees as active after restart.
  const ptyIdsByTabId = snapshot.ptyIdsByTabId
  const hasLivePty = (tabId: string): boolean => (ptyIdsByTabId[tabId]?.length ?? 0) > 0

  // Why: lastKnownRelayPtyIdByTabId preserves remote session IDs across relay
  // disconnect/reconnect cycles, where clearTabPtyId(null) clears tab.ptyId
  // but keeps the relay PTY alive. Sleep is different: it preserves tab.ptyId
  // as a wake hint after clearing ptyIdsByTabId, so that shape must not count
  // as active on restart.
  const lastKnown = snapshot.lastKnownRelayPtyIdByTabId
  const hasReconnectableSession = (tab: { id: string; ptyId: string | null }): boolean =>
    hasLivePty(tab.id) || (!tab.ptyId && Boolean(lastKnown[tab.id]))

  const activeWorktreeIdsOnShutdown = Object.entries(tabsByWorktree)
    .filter(([, tabs]) => tabs.some(hasReconnectableSession))
    .map(([worktreeId]) => worktreeId)

  const worktreeById = new Map(
    Object.values(snapshot.worktreesByRepo)
      .flat()
      .map((worktree) => [worktree.id, worktree])
  )
  const repoById = new Map(snapshot.repos.map((repo) => [repo.id, repo]))

  // Why: the renderer already has tab.ptyId for every terminal tab and knows
  // which worktrees are SSH-backed via repo.connectionId. Deriving the map
  // here avoids a sync IPC round-trip during beforeunload, which is fragile
  // (can be dropped by Chromium under shutdown time pressure).
  // Why: this builder runs from the session-write debounce and beforeunload.
  // Pre-index repo/worktree identity once so large workspaces don't rescan all
  // repos/worktrees for every terminal tab while the renderer is trying to quit.
  const remoteSessionIdsByTabId: Record<string, string> = {}
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const worktree = worktreeById.get(worktreeId)
    const repo = worktree ? repoById.get(worktree.repoId) : null
    if (!repo?.connectionId) {
      continue
    }
    for (const tab of tabs) {
      if (!hasReconnectableSession(tab)) {
        continue
      }
      const sessionId = tab.ptyId || lastKnown[tab.id]
      if (sessionId) {
        remoteSessionIdsByTabId[tab.id] = sessionId
      }
    }
  }

  return {
    activeWorktreeIdsOnShutdown,
    remoteSessionIdsByTabId:
      Object.keys(remoteSessionIdsByTabId).length > 0 ? remoteSessionIdsByTabId : undefined
  }
}

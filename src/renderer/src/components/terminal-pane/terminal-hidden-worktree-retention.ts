import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { terminalProviderHasAuthoritativeSnapshot } from '../terminal/terminal-provider-snapshot-capability'
import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  selectIdsBeyondHotRetain,
  type ColdParkRetainCandidate,
  type TerminalColdParkPolicyOverrides
} from './terminal-hidden-view-parking'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { createWorktreeTabBucketProjection } from '@/lib/worktree-tab-bucket-projection'

// Why these sizes: a retained hidden pane costs a measured ~2.5MB of V8 heap
// at the 5k-row default scrollback and ~19MB at 50k (plus per-pane queues),
// not the ~4-5MB per WORKTREE the warm cap assumed — so un-parkable worktrees
// (pty classes parking can't restore) get a retention budget: at most 4 stay
// mounted while hidden and none past 15 minutes, evicted least-recently-hidden
// first via force-park. The TTL is absolute: the last-active exemption bounds
// the cap, never the clock.
// NOT covered by this bound: eviction-exempt TABS (isEvictionExemptTerminalPty
// — live local ptys a remount would respawn, orphaning the shell). Their panes
// stay mounted through a force-park at any age, so a fleet-wide daemon
// fail-open can leave the budget freeing nothing; Terminal.tsx logs that
// degenerate case rather than pretending the bound held.
// Also NOT covered: per-pane scrollback size. Hidden-pane scrollback demotion
// was intentionally removed — the bound is worktree count + TTL only, so a
// spared worktree (last-active, exempt tabs) can hold full 50k-row scrollback
// indefinitely. Accepted tradeoff: high-scrollback users rely on unmount
// eviction, not demotion.
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT = 4
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS = 15 * 60_000
/**
 * Second bound, in the unit the cost is actually paid in.
 *
 * Why: the cap above counts WORKTREES, but a hidden worktree costs whatever its
 * mounted panes hold, and nothing bounds panes-per-worktree. Measured on
 * Windows against this app: 6 worktrees x 4 terminal tabs filled with 8000
 * lines each left 24 mounted panes holding 19.3M buffer cells, and a renderer
 * that idled at 566MB with only one worktree visible — the worktree cap had
 * evicted 4 panes and then plateaued, exactly as designed and nowhere near
 * enough. Four worktrees x N tabs x scrollback has no ceiling at all, and the
 * scrollback setting goes to 50k rows.
 *
 * 8 panes is ~62MB of buffers at the 5k-row default (~12MB/pane measured at
 * 8000 rows, ~7.7MB at 5k). It leaves the ordinary working set — four hidden
 * worktrees at one or two tabs each — entirely untouched, and only engages for
 * the many-pane tail. Tune it here; it is one number and it is not load-bearing
 * for correctness.
 */
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_PANE_LIMIT = 8

export function createTerminalWorktreeTopologyProjection(
  onInspectBucket?: (worktreeId: string) => void
) {
  return createWorktreeTabBucketProjection<TerminalTab, TerminalTab>({
    projectTab: (tab) => tab,
    isSameProjectedTab: (previousTab, nextTab) =>
      previousTab.id === nextTab.id &&
      previousTab.ptyId === nextTab.ptyId &&
      previousTab.worktreeId === nextTab.worktreeId &&
      previousTab.pendingActivationSpawn === nextTab.pendingActivationSpawn &&
      previousTab.generation === nextTab.generation &&
      previousTab.startupCwd === nextTab.startupCwd,
    onInspectBucket
  })
}

export function hasPendingRetentionSpawnWork(
  tab: Pick<TerminalTab, 'id' | 'ptyId' | 'pendingActivationSpawn'>,
  pendingStartupByTabId: Readonly<Record<string, unknown>>
): boolean {
  if (pendingStartupByTabId[tab.id] !== undefined) {
    return true
  }
  // Why: paired mirrors never spawn locally; their host-backed PTY id proves
  // activation's sort-suppression residue cannot represent unfinished work.
  return Boolean(tab.pendingActivationSpawn && (!tab.ptyId || !isRemoteRuntimePtyId(tab.ptyId)))
}

// Why: an eviction-exempt pty is a live local one a remount cannot restore
// faithfully (daemon-fail-open/foreign ids or a preserved legacy daemon). Its
// TAB keeps its mounted pane when the worktree force-parks.
// Per-PTY, not per-tab: the coverage veto that makes a worktree a retention
// candidate walks every split pane, so the exemption must too (see
// isEvictionExemptTerminalTab).
export function isEvictionExemptTerminalPty(
  ptyId: string | null | undefined,
  worktreeId: string
): boolean {
  return classifyEvictionExemptTerminalPty(ptyId, worktreeId) !== null
}

export type EvictionExemptTerminalPtyRoute = 'fail-open' | 'foreign-worktree' | 'capability-unknown'

// Why routes: an all-exempt force-park frees nothing, and only per-route
// counts in the field can say whether daemon fail-open ids or unresolved
// snapshot capability dominates that degenerate case.
export function classifyEvictionExemptTerminalPty(
  ptyId: string | null | undefined,
  worktreeId: string
): EvictionExemptTerminalPtyRoute | null {
  if (!ptyId || isRemoteRuntimePtyId(ptyId) || parseAppSshPtyId(ptyId)) {
    return null
  }
  const separatorIdx = ptyId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  if (separatorIdx === -1) {
    return 'fail-open'
  }
  if (ptyId.slice(0, separatorIdx) !== worktreeId) {
    return 'foreign-worktree'
  }
  return terminalProviderHasAuthoritativeSnapshot(ptyId) ? null : 'capability-unknown'
}

export type EvictionExemptRouteCounts = {
  failOpen: number
  foreignWorktree: number
  capabilityUnknown: number
  /** Tab-level pty classifies clean, so the exemption came from a split pane's pty. */
  splitPane: number
}

export function countEvictionExemptTabRoutes(
  tabs: readonly Pick<TerminalTab, 'ptyId'>[],
  worktreeId: string
): EvictionExemptRouteCounts {
  const counts: EvictionExemptRouteCounts = {
    failOpen: 0,
    foreignWorktree: 0,
    capabilityUnknown: 0,
    splitPane: 0
  }
  for (const tab of tabs) {
    switch (classifyEvictionExemptTerminalPty(tab.ptyId, worktreeId)) {
      case 'fail-open':
        counts.failOpen += 1
        break
      case 'foreign-worktree':
        counts.foreignWorktree += 1
        break
      case 'capability-unknown':
        counts.capabilityUnknown += 1
        break
      case null:
        counts.splitPane += 1
        break
    }
  }
  return counts
}

/**
 * Panes a worktree keeps mounted: split leaves where a layout exists, else one
 * per tab. This is the unit the retention pane budget is spent in.
 */
export function countMountedWorktreePanes(
  tabs: readonly Pick<TerminalTab, 'id'>[],
  layoutsByTabId: Readonly<Record<string, { ptyIdsByLeafId?: Readonly<Record<string, string>> }>>
): number {
  let panes = 0
  for (const tab of tabs) {
    const leafIds = layoutsByTabId[tab.id]?.ptyIdsByLeafId
    const leafCount = leafIds ? Object.keys(leafIds).length : 0
    // An unsplit tab has no layout row yet; it still holds one mounted pane.
    panes += leafCount > 0 ? leafCount : 1
  }
  return panes
}

export function formatEvictionExemptRouteCounts(counts: EvictionExemptRouteCounts): string {
  return `routes=fail-open:${counts.failOpen},foreign:${counts.foreignWorktree},capability:${counts.capabilityUnknown},split-pane:${counts.splitPane}`
}

export type TerminalWorktreeRetentionCandidate = {
  worktreeId: string
  hiddenSinceMs: number | null
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  /** Post-measure cool-down (see TerminalWorktreeColdParkCandidate): force-park
   *  must not re-engage right after a measure window ends, but hiddenSince —
   *  and with it the TTL/ranking clock — stays untouched. */
  parkCooldownUntilMs?: number | null
  /** Ordinary cold parking can evict this worktree (park-eligible AND watcher-coverable) — the warm cap bounds it already. */
  ordinaryParkingCovers: boolean
  /** Pending startup or activation spawn — a mount is imminent; never evict. */
  hasPendingSpawnWork: boolean
  /**
   * Panes this worktree keeps mounted while hidden (split leaves, not tabs).
   * Omitted means "unknown", which is counted as one pane rather than zero so a
   * missing layout can never make a worktree look free to retain.
   */
  mountedPaneCount?: number
}

/**
 * Retention budget over the worktrees ordinary parking can never evict: any
 * hidden un-parkable worktree beyond the retention limit or TTL force-parks —
 * panes unmount, watchers cover the tabs whose transport exists, and reveal
 * restores per pty class (the app-restart experience). Eviction-exempt tabs
 * do NOT veto the worktree: they keep their mounted panes via the per-tab
 * exclusion (Activity-portal pattern) while sibling tabs unmount, so one
 * exempt tab can no longer pin co-located remote-runtime tabs forever.
 * Ranking reuses the hot-retain machinery, so deterministic ties hold here too,
 * and the verdict changes only at deadlines or on real state transitions (no
 * new flip-loop inputs). The last-active exemption it carries spares one
 * worktree from the CAP only — the TTL below overrides it, else a lone hidden
 * un-parkable worktree would stay mounted for the whole session.
 */
export function selectRetentionForceParkedTerminalWorktrees(
  args: {
    worktrees: readonly TerminalWorktreeRetentionCandidate[]
    parkingEnabled: boolean
    retentionBudgetEnabled: boolean
    nowMs: number
  } & TerminalColdParkPolicyOverrides
): Set<string> {
  if (!args.parkingEnabled || !args.retentionBudgetEnabled) {
    return new Set()
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
  const candidates: ColdParkRetainCandidate[] = []
  const paneCountsById = new Map<string, number>()
  for (const worktree of args.worktrees) {
    if (
      worktree.hiddenSinceMs === null ||
      worktree.isVisible ||
      worktree.shouldMeasureHiddenWorktree ||
      worktree.hasActivityTerminalPortal ||
      worktree.ordinaryParkingCovers ||
      worktree.hasPendingSpawnWork ||
      (worktree.parkCooldownUntilMs != null && args.nowMs < worktree.parkCooldownUntilMs) ||
      args.nowMs - worktree.hiddenSinceMs < coldParkDelayMs
    ) {
      continue
    }
    candidates.push({ id: worktree.worktreeId, hiddenSinceMs: worktree.hiddenSinceMs })
    paneCountsById.set(worktree.worktreeId, worktree.mountedPaneCount ?? 1)
  }
  const retentionTtlMs = args.retentionTtlMs ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
  const forceParkedIds = selectIdsBeyondHotRetain(candidates, {
    nowMs: args.nowMs,
    hotRetainMs: retentionTtlMs,
    hotRetainLimit: args.retentionLimit ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT
  })
  // Why re-applied here: selectIdsBeyondHotRetain spares the last-active id from
  // its clock too, which is right for the warm cap (instant return after a
  // meeting) but makes "none past 15 minutes" false for a lone hidden worktree.
  for (const candidate of candidates) {
    if (args.nowMs - candidate.hiddenSinceMs >= retentionTtlMs) {
      forceParkedIds.add(candidate.id)
    }
  }
  addPaneBudgetForceParkedIds(
    candidates,
    paneCountsById,
    forceParkedIds,
    args.retentionPaneLimit ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_PANE_LIMIT
  )
  return forceParkedIds
}

/**
 * Force-parks whatever the worktree cap left retained once its mounted panes
 * exceed the pane budget, least-recently-hidden first.
 *
 * Why it runs after the cap rather than replacing it: the cap is what keeps the
 * ordinary rotation warm, and one worktree can legitimately hold more panes
 * than the budget. The most-recently-hidden worktree is spared here for the
 * same reason it is spared there — it is the view the user just left, and
 * remounting it is the cost they actually notice.
 */
function addPaneBudgetForceParkedIds(
  candidates: readonly ColdParkRetainCandidate[],
  paneCountsById: ReadonlyMap<string, number>,
  forceParkedIds: Set<string>,
  paneLimit: number
): void {
  const retained = candidates.filter((candidate) => !forceParkedIds.has(candidate.id))
  if (retained.length <= 1) {
    return
  }
  // Newest hidden first: the same ranking the cap evicts by, reversed.
  const ranked = [...retained].sort((left, right) => {
    if (left.hiddenSinceMs !== right.hiddenSinceMs) {
      return right.hiddenSinceMs - left.hiddenSinceMs
    }
    const activationDelta = (right.lastActivatedSeq ?? -1) - (left.lastActivatedSeq ?? -1)
    return activationDelta === 0 ? left.id.localeCompare(right.id) : activationDelta
  })
  let panes = 0
  for (let index = 0; index < ranked.length; index += 1) {
    const candidate = ranked[index]
    // Why 1 and not 0 for an unknown count: a worktree whose layout we cannot
    // read must never look free, or a missing layout silently lifts the budget.
    panes += paneCountsById.get(candidate.id) ?? 1
    if (index > 0 && panes > paneLimit) {
      forceParkedIds.add(candidate.id)
    }
  }
}

// Why exported: an all-exempt force-park frees nothing, and that degenerate
// case is only observable if the empty selection is a value the host can test.
export function selectForceParkEvictableTabIds<T extends { id: string }>(
  tabs: readonly T[],
  isExempt: (tab: T) => boolean
): string[] {
  return tabs.filter((tab) => !isExempt(tab)).map((tab) => tab.id)
}

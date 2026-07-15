import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { parsePtySessionId } from '../../../../shared/pty-session-id-format'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
// Why: not runtime-terminal-inspection — that module imports the store, and a
// store slice importing it back would make store creation order-dependent.
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

/**
 * Liveness evidence for PTY session ids the workspace still claims.
 *
 * The claim maps (tab.ptyId wake hints, ptyIdsByTabId, layout ptyIdsByLeafId)
 * deliberately outlive the daemon session: a dead id is still the key to
 * daemon-side cold-restore history and sleep/hibernation wake. They must never
 * be pruned for accounting reasons. `deadPtyIds` records "this session is not
 * running" evidence separately so surfaces that count RUNNING sessions (the
 * closed Resource Manager badge) can subtract it while every reattach/restore
 * path keeps its hints (#8372). An id leaves the record only when a live pane
 * registers it again (updateTabPtyId) or its claims disappear.
 */
export type PtySessionClaimMaps = {
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
}

/** Every PTY session id the claim maps currently reference. */
export function collectClaimedPtyIds(maps: PtySessionClaimMaps): Set<string> {
  const claimed = new Set<string>()
  for (const ptyIds of Object.values(maps.ptyIdsByTabId)) {
    for (const ptyId of ptyIds) {
      claimed.add(ptyId)
    }
  }
  for (const tabs of Object.values(maps.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.ptyId) {
        claimed.add(tab.ptyId)
      }
    }
  }
  for (const layout of Object.values(maps.terminalLayoutsByTabId)) {
    for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
      if (ptyId) {
        claimed.add(ptyId)
      }
    }
  }
  return claimed
}

/**
 * Whether a successful `pty:listSessions` result is authoritative about this
 * id. The local daemon listing fails closed (the router rejects on any adapter
 * error), so absence there proves death — but SSH providers degrade to `[]`
 * on transport errors and runtime (`remote:`) handles never appear at all, so
 * absence proves nothing for those namespaces.
 */
export function isLocalDaemonMintedPtyId(ptyId: string): boolean {
  return (
    parseRemoteRuntimePtyId(ptyId) === null &&
    parseAppSshPtyId(ptyId) === null &&
    parsePtySessionId(ptyId).worktreeId !== null
  )
}

/**
 * Claims an authoritative session listing proves dead.
 *
 * `claimedBeforeRequest` / `attachedBeforeRequest` must be snapshotted before
 * the listSessions RPC is issued: a session spawned or woken mid-flight is
 * missing from the (older) listing, and only the pre-request snapshot keeps it
 * from being declared dead.
 */
export function deriveExitedPtyIdsFromListing(args: {
  claimedBeforeRequest: ReadonlySet<string>
  attachedBeforeRequest: ReadonlySet<string>
  attachedNow: ReadonlySet<string>
  listedSessionIds: ReadonlySet<string>
}): string[] {
  const exitedPtyIds: string[] = []
  for (const ptyId of args.claimedBeforeRequest) {
    if (args.listedSessionIds.has(ptyId) || !isLocalDaemonMintedPtyId(ptyId)) {
      continue
    }
    if (args.attachedNow.has(ptyId) && !args.attachedBeforeRequest.has(ptyId)) {
      continue
    }
    exitedPtyIds.push(ptyId)
  }
  return exitedPtyIds
}

/**
 * Dead marks worth persisting: only ids still claimed as wake hints — marks
 * for released claims are noise that would grow the session file without bound.
 */
export function collectPersistableDeadPtyIds(
  deadPtyIds: Record<string, true>,
  claims: PtySessionClaimMaps
): string[] | undefined {
  const dead = Object.keys(deadPtyIds)
  if (dead.length === 0) {
    return undefined
  }
  const claimed = collectClaimedPtyIds(claims)
  const persisted = dead.filter((ptyId) => claimed.has(ptyId)).slice(0, 4096)
  return persisted.length > 0 ? persisted : undefined
}

/**
 * Record exited ids in the dead-id record. Returns the next record, or null
 * when nothing changed so callers can skip the store write. Entries no longer
 * claimed anywhere are dropped to keep the record claim-bounded.
 */
export function markPtySessionsExited(
  current: Record<string, true>,
  exitedPtyIds: readonly string[],
  claims: PtySessionClaimMaps
): Record<string, true> | null {
  const claimed = collectClaimedPtyIds(claims)
  const next: Record<string, true> = {}
  let changed = false
  for (const ptyId of Object.keys(current)) {
    if (claimed.has(ptyId)) {
      next[ptyId] = true
    } else {
      changed = true
    }
  }
  for (const ptyId of exitedPtyIds) {
    if (claimed.has(ptyId) && !next[ptyId]) {
      next[ptyId] = true
      changed = true
    }
  }
  return changed ? next : null
}

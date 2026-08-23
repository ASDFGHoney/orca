import { webContents } from 'electron'
import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  GitHubPRRefreshSkippedReason,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import { lookupBackoffDelayMs } from '../source-control/hosted-review-refresh-pacing'
import { recordCoalescedCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { sendToTrustedUIRenderer } from '../ipc/ui'

const DIAGNOSTIC_BREADCRUMB_MIN_INTERVAL_MS = 30_000

export type QueueEntry = {
  key: string
  candidate: GitHubPRRefreshCandidate
  aliases: Map<string, GitHubPRRefreshAlias>
  reason: GitHubPRRefreshReason
  priority: number
  dueAt: number
  queuedAt: number
  bypassBackgroundBudget?: boolean
  activeDelayNotified?: boolean
  windowId?: number
}

export type PRRefreshOutcomeObserver = (
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome
) => void

export const refreshQueue = new Map<string, QueueEntry>()
export const visibleRefreshesByWindow = new Map<number, { generation: number; keys: Set<string> }>()

const errorBackoff = new Map<string, { failures: number; retryAt: number }>()
const manualRetryGates = new Map<string, number>()
let sequence = 0
let queueOrder = 0
let outcomeObserver: PRRefreshOutcomeObserver | null = null

const diagnosticsCounters = {
  enqueued: 0,
  coalesced: 0,
  skipped: 0,
  backgroundPauses: 0
}

export function setRefreshOutcomeObserver(observer: PRRefreshOutcomeObserver | null): void {
  outcomeObserver = observer
}

export function notifyRefreshOutcome(
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome
): void {
  outcomeObserver?.(candidate, outcome)
}

export function nextRefreshSequence(): number {
  sequence += 1
  return sequence
}

export function nextRefreshQueueOrder(): number {
  queueOrder += 1
  return queueOrder
}

export function broadcastRefreshEvent(
  event: Omit<GitHubPRRefreshEvent, 'sequence'>,
  sequenceOverride?: number
): void {
  const payload = {
    ...event,
    sequence: sequenceOverride ?? nextRefreshSequence()
  } as GitHubPRRefreshEvent
  sendToTrustedUIRenderer('gh:prRefreshEvent', payload)
}

export function recordRefreshQueueDiagnostic(
  event: 'enqueued' | 'coalesced' | 'skipped' | 'background-pause',
  reason: GitHubPRRefreshReason,
  skippedReason?: GitHubPRRefreshSkippedReason
): void {
  if (event === 'enqueued') {
    diagnosticsCounters.enqueued += 1
  }
  if (event === 'coalesced') {
    diagnosticsCounters.coalesced += 1
  }
  if (event === 'skipped') {
    diagnosticsCounters.skipped += 1
  }
  if (event === 'background-pause') {
    diagnosticsCounters.backgroundPauses += 1
  }
  recordCoalescedCrashBreadcrumb({
    name: 'pr_refresh_queue',
    coalesceKey: `pr-refresh-queue:${event}:${reason}:${skippedReason ?? ''}`,
    minIntervalMs: DIAGNOSTIC_BREADCRUMB_MIN_INTERVAL_MS,
    data: {
      event,
      reason,
      ...(skippedReason ? { skippedReason } : {}),
      enqueued: diagnosticsCounters.enqueued,
      coalesced: diagnosticsCounters.coalesced,
      skipped: diagnosticsCounters.skipped,
      backgroundPauses: diagnosticsCounters.backgroundPauses
    }
  })
}

export function isRefreshKeyVisible(key: string): boolean {
  const liveWindowIds = new Set(
    webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed())
      .map((contents) => contents.id)
  )
  for (const windowId of Array.from(visibleRefreshesByWindow.keys())) {
    if (!liveWindowIds.has(windowId)) {
      visibleRefreshesByWindow.delete(windowId)
    }
  }
  for (const visible of visibleRefreshesByWindow.values()) {
    if (visible.keys.has(key)) {
      return true
    }
  }
  return false
}

export function removeInvisibleVisibleRefreshes(): void {
  for (const [key, entry] of refreshQueue) {
    if (entry.reason === 'visible' && !isRefreshKeyVisible(key)) {
      refreshQueue.delete(key)
      resetRefreshRetryState(key)
      broadcastRefreshEvent({
        aliases: Array.from(entry.aliases.values()),
        reason: 'visible',
        status: 'skipped',
        skippedReason: 'fresh'
      })
    }
  }
}

export function removeQueuedAliasForInvalidCandidate(
  key: string,
  alias: GitHubPRRefreshAlias
): void {
  const existing = refreshQueue.get(key)
  if (!existing) {
    return
  }
  existing.aliases.delete(alias.cacheKey)
  const replacementAlias = existing.aliases.values().next().value
  if (!replacementAlias) {
    refreshQueue.delete(key)
    resetRefreshRetryState(key)
    return
  }
  if (existing.candidate.cacheKey === alias.cacheKey) {
    existing.candidate = {
      ...existing.candidate,
      cacheKey: replacementAlias.cacheKey,
      branch: replacementAlias.branch,
      worktreeId: replacementAlias.worktreeId,
      currentHeadOid: replacementAlias.currentHeadOid ?? null,
      isArchived: false,
      isBare: false
    }
  }
}

export function pruneWorktreeRefreshAliases(worktreeId: string): void {
  for (const [key, entry] of refreshQueue) {
    let removed = false
    for (const [cacheKey, alias] of entry.aliases) {
      if (alias.worktreeId === worktreeId) {
        entry.aliases.delete(cacheKey)
        removed = true
      }
    }
    if (!removed) {
      continue
    }
    if (entry.aliases.size === 0) {
      refreshQueue.delete(key)
      resetRefreshRetryState(key)
      continue
    }
    if (entry.candidate.worktreeId === worktreeId) {
      const replacementAlias = entry.aliases.values().next().value
      if (replacementAlias) {
        entry.candidate = {
          ...entry.candidate,
          cacheKey: replacementAlias.cacheKey,
          branch: replacementAlias.branch,
          worktreeId: replacementAlias.worktreeId,
          currentHeadOid: replacementAlias.currentHeadOid ?? null
        }
      }
    }
  }
}

export function noteManualRetryGate(key: string, outcome: PRRefreshOutcome): void {
  if (outcome.kind === 'upstream-error' && outcome.retryDisabledUntil !== undefined) {
    manualRetryGates.set(key, outcome.retryDisabledUntil)
  } else {
    manualRetryGates.delete(key)
  }
}

export function manualRetryGateUntil(key: string): number | undefined {
  return manualRetryGates.get(key)
}

export function resetRefreshRetryState(key: string): void {
  errorBackoff.delete(key)
  manualRetryGates.delete(key)
}

export function nextVisibleErrorRetryAt(key: string): number {
  const failures = (errorBackoff.get(key)?.failures ?? 0) + 1
  const retryAt = Date.now() + lookupBackoffDelayMs(failures)
  errorBackoff.set(key, { failures, retryAt })
  return retryAt
}

export function withErrorSchedule(outcome: PRRefreshOutcome, retryAt: number): PRRefreshOutcome {
  if (outcome.kind !== 'upstream-error') {
    return outcome
  }
  const cooldownUntil = outcome.retryDisabledUntil
  return {
    ...outcome,
    nextAutoRetryAt: cooldownUntil !== undefined ? Math.max(retryAt, cooldownUntil) : retryAt
  }
}

export function visibleRefreshWindowCount(): number {
  return visibleRefreshesByWindow.size
}

export function refreshErrorBackoffCount(): number {
  return errorBackoff.size
}

export function refreshQueueAliasCount(key: string): number {
  return refreshQueue.get(key)?.aliases.size ?? 0
}

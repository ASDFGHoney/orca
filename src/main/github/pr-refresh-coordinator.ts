import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import {
  aliasFromCandidate,
  bypassesFreshnessDelay,
  freshRetryAt,
  MANUAL_MERGEABILITY_PENDING_REFRESH_MS,
  POST_PUSH_DELAY_MS,
  refreshKey,
  shouldBroadcastQueued,
  shouldSkipFresh,
  validateCandidate
} from './pr-refresh-candidate-policy'
import { getGitHubRefreshRateLimitRetryAt, queryGitHubPullRequest } from './pr-refresh-github-query'
import { clearActiveRefreshBurstWindow } from './pr-refresh-pacing'
import { schedulePRRefreshDrain } from './pr-refresh-queue-drain'
import {
  broadcastRefreshEvent,
  isRefreshKeyVisible,
  manualRetryGateUntil,
  nextRefreshQueueOrder,
  nextRefreshSequence,
  nextVisibleErrorRetryAt,
  noteManualRetryGate,
  notifyRefreshOutcome,
  pruneWorktreeRefreshAliases,
  recordRefreshQueueDiagnostic,
  refreshErrorBackoffCount,
  refreshQueue,
  refreshQueueAliasCount,
  removeInvisibleVisibleRefreshes,
  removeQueuedAliasForInvalidCandidate,
  setRefreshOutcomeObserver,
  visibleRefreshesByWindow,
  visibleRefreshWindowCount,
  withErrorSchedule,
  type PRRefreshOutcomeObserver
} from './pr-refresh-queue-state'
import { scheduleVisiblePRRefreshFollowUp } from './pr-refresh-visible-follow-up'

export function setPRRefreshOutcomeObserver(observer: PRRefreshOutcomeObserver | null): void {
  setRefreshOutcomeObserver(observer)
}

export function clearVisiblePRRefreshWindow(windowId: number): void {
  const hadVisibleRefreshes = visibleRefreshesByWindow.delete(windowId)
  clearActiveRefreshBurstWindow(windowId)
  if (hadVisibleRefreshes) {
    removeInvisibleVisibleRefreshes()
  }
}

export function pruneWorktreePRRefreshAliases(worktreeId: string): void {
  pruneWorktreeRefreshAliases(worktreeId)
}

export function enqueuePRRefresh(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason,
  priority = 0,
  windowId?: number
): void {
  const alias = aliasFromCandidate(candidate)
  const key = refreshKey(candidate)
  const skippedReason = validateCandidate(candidate)
  if (skippedReason) {
    removeQueuedAliasForInvalidCandidate(key, alias)
    recordRefreshQueueDiagnostic('skipped', reason, skippedReason)
    broadcastRefreshEvent({ aliases: [alias], reason, status: 'skipped', skippedReason })
    return
  }

  const existing = refreshQueue.get(key)
  const freshDueAt = shouldSkipFresh(candidate, reason) ? freshRetryAt(candidate) : null
  const dueAt = freshDueAt ?? Date.now() + (reason === 'post-push' ? POST_PUSH_DELAY_MS : 0)
  if (existing) {
    existing.aliases.set(alias.cacheKey, alias)
    recordRefreshQueueDiagnostic('coalesced', reason)
    const shouldPromoteExisting =
      priority > existing.priority ||
      reason === 'manual' ||
      (reason === 'active' && existing.reason === 'active') ||
      (priority >= existing.priority && dueAt < existing.dueAt && bypassesFreshnessDelay(reason))
    if (shouldPromoteExisting) {
      existing.priority = priority
      existing.reason = reason
      existing.dueAt = Math.min(existing.dueAt, dueAt)
      existing.queuedAt = nextRefreshQueueOrder()
      existing.activeDelayNotified = false
      existing.candidate = candidate
      existing.windowId = windowId ?? existing.windowId
    } else if (existing.candidate.worktreeId === candidate.worktreeId) {
      existing.candidate = {
        ...existing.candidate,
        cacheKey: candidate.cacheKey,
        branch: candidate.branch,
        currentHeadOid: candidate.currentHeadOid ?? null
      }
    }
  } else {
    recordRefreshQueueDiagnostic('enqueued', reason)
    refreshQueue.set(key, {
      key,
      candidate,
      aliases: new Map([[alias.cacheKey, alias]]),
      reason,
      priority,
      dueAt,
      queuedAt: nextRefreshQueueOrder(),
      windowId
    })
  }
  if (shouldBroadcastQueued(reason, dueAt)) {
    broadcastRefreshEvent({ aliases: [alias], reason, status: 'queued' })
  }
  schedulePRRefreshDrain()
}

export function reportVisiblePRRefreshCandidates(
  candidates: GitHubPRRefreshCandidate[],
  generation: number,
  windowId: number
): void {
  const existingVisible = visibleRefreshesByWindow.get(windowId)
  if (existingVisible && generation < existingVisible.generation) {
    return
  }
  visibleRefreshesByWindow.set(windowId, {
    generation,
    keys: new Set(candidates.map(refreshKey))
  })
  removeInvisibleVisibleRefreshes()
  for (const candidate of candidates) {
    enqueuePRRefresh(candidate, 'visible', 40, windowId)
  }
}

export function _getVisiblePRRefreshWindowCountForTests(): number {
  return visibleRefreshWindowCount()
}

export function _getPRRefreshErrorBackoffCountForTests(): number {
  return refreshErrorBackoffCount()
}

export function _getPRRefreshQueueSizeForTests(): number {
  return refreshQueue.size
}

export function _getPRRefreshAliasCountForTests(key: string): number {
  return refreshQueueAliasCount(key)
}

export async function refreshPRNow(candidate: GitHubPRRefreshCandidate): Promise<PRRefreshOutcome> {
  const alias = aliasFromCandidate(candidate)
  const key = refreshKey(candidate)
  const existing = refreshQueue.get(key)
  const aliasMap = new Map(existing ? existing.aliases : [])
  aliasMap.set(alias.cacheKey, alias)
  const aliases = Array.from(aliasMap.values())
  const skippedReason = validateCandidate(candidate)
  if (skippedReason) {
    removeQueuedAliasForInvalidCandidate(key, alias)
    const outcome: PRRefreshOutcome = {
      kind: 'upstream-error',
      errorType: 'unknown',
      message: `Cannot refresh PR for this worktree: ${skippedReason}`,
      fetchedAt: Date.now()
    }
    broadcastRefreshEvent({ aliases: [alias], reason: 'manual', status: 'skipped', skippedReason })
    return outcome
  }

  const primaryGateUntil = await getGitHubRefreshRateLimitRetryAt(candidate, false)
  const secondaryGateUntil = manualRetryGateUntil(key)
  const gateUntil = Math.max(primaryGateUntil ?? 0, secondaryGateUntil ?? 0)
  if (gateUntil > Date.now()) {
    const retryAt = gateUntil
    refreshQueue.set(key, {
      key,
      candidate,
      aliases: aliasMap,
      reason: 'manual',
      priority: 40,
      dueAt: retryAt,
      queuedAt: nextRefreshQueueOrder()
    })
    broadcastRefreshEvent({
      aliases,
      reason: 'manual',
      status: 'paused',
      pausedUntil: retryAt,
      skippedReason: 'rate-limit'
    })
    schedulePRRefreshDrain(Math.max(1_000, retryAt - Date.now()))
    return {
      kind: 'upstream-error',
      errorType: 'rate_limited',
      message: 'GitHub is temporarily limiting requests. Try again after the limit resets.',
      fetchedAt: Date.now(),
      nextAutoRetryAt: retryAt,
      retryDisabledUntil: retryAt
    }
  }

  refreshQueue.delete(key)
  const requestSequence = nextRefreshSequence()
  const requestStartedAt = Date.now()
  broadcastRefreshEvent(
    { aliases, reason: 'manual', status: 'in-flight', requestStartedAt },
    requestSequence
  )
  const outcome = await queryGitHubPullRequest(candidate)
  let plannedRetryAt: number | undefined
  let broadcastOutcome = outcome
  if (outcome.kind === 'upstream-error' && isRefreshKeyVisible(key)) {
    plannedRetryAt = nextVisibleErrorRetryAt(key)
    broadcastOutcome = withErrorSchedule(outcome, plannedRetryAt)
  }
  notifyRefreshOutcome(candidate, outcome)
  noteManualRetryGate(key, broadcastOutcome)
  broadcastRefreshEvent(
    { aliases, reason: 'manual', outcome: broadcastOutcome, requestStartedAt },
    requestSequence
  )
  scheduleVisiblePRRefreshFollowUp(
    key,
    candidate,
    outcome,
    40,
    aliases,
    schedulePRRefreshDrain,
    undefined,
    { plannedRetryAt, pendingMergeabilityDelayMs: MANUAL_MERGEABILITY_PENDING_REFRESH_MS }
  )
  return broadcastOutcome
}

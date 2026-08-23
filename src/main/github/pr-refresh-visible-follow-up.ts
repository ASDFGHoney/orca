import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import {
  bypassesFreshnessDelay,
  freshRetryAt,
  isMergeabilityPendingOutcome,
  visibleCandidateAfterOutcome
} from './pr-refresh-candidate-policy'
import {
  isRefreshKeyVisible,
  nextRefreshQueueOrder,
  nextVisibleErrorRetryAt,
  refreshQueue,
  resetRefreshRetryState,
  type QueueEntry
} from './pr-refresh-queue-state'

type ScheduleDrain = (delay?: number) => void

function setVisibleFollowUp(entry: QueueEntry): void {
  const existing = refreshQueue.get(entry.key)
  if (!existing) {
    refreshQueue.set(entry.key, entry)
    return
  }
  for (const alias of entry.aliases.values()) {
    existing.aliases.set(alias.cacheKey, alias)
  }
  if (
    bypassesFreshnessDelay(existing.reason) ||
    existing.priority > entry.priority ||
    existing.dueAt <= entry.dueAt
  ) {
    return
  }
  refreshQueue.set(entry.key, {
    ...entry,
    aliases: existing.aliases
  })
}

export function scheduleVisiblePRRefreshFollowUp(
  key: string,
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome,
  priority: number,
  aliases: GitHubPRRefreshAlias[],
  scheduleDrain: ScheduleDrain,
  windowId?: number,
  options?: { pendingMergeabilityDelayMs?: number; plannedRetryAt?: number }
): void {
  if (!isRefreshKeyVisible(key)) {
    resetRefreshRetryState(key)
    return
  }
  if (outcome.kind === 'upstream-error') {
    const retryAt = options?.plannedRetryAt ?? nextVisibleErrorRetryAt(key)
    setVisibleFollowUp({
      key,
      candidate,
      aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
      reason: 'visible',
      priority,
      dueAt: retryAt,
      queuedAt: nextRefreshQueueOrder(),
      windowId
    })
    scheduleDrain(retryAt - Date.now())
    return
  }
  resetRefreshRetryState(key)
  const followUpCandidate = visibleCandidateAfterOutcome(candidate, outcome)
  const regularDueAt = freshRetryAt(followUpCandidate) ?? Date.now()
  const pendingMergeabilityDueAt =
    options?.pendingMergeabilityDelayMs !== undefined && isMergeabilityPendingOutcome(outcome)
      ? outcome.fetchedAt + options.pendingMergeabilityDelayMs
      : null
  const dueAt =
    pendingMergeabilityDueAt === null
      ? regularDueAt
      : Math.min(regularDueAt, pendingMergeabilityDueAt)
  setVisibleFollowUp({
    key,
    candidate: followUpCandidate,
    aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
    reason: 'visible',
    priority,
    dueAt,
    queuedAt: nextRefreshQueueOrder(),
    bypassBackgroundBudget: pendingMergeabilityDueAt !== null,
    windowId
  })
  scheduleDrain(Math.max(0, dueAt - Date.now()))
}

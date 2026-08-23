import { isBackground, validateCandidate } from './pr-refresh-candidate-policy'
import { getGitHubRefreshRateLimitRetryAt, queryGitHubPullRequest } from './pr-refresh-github-query'
import {
  activeRefreshOrder,
  isBudgetedQueueEntry,
  nextActiveBurstDelay,
  nextBackgroundBudgetDelay,
  noteActiveRefreshStart,
  noteBackgroundRefreshStart,
  refreshEntryPacingDelay
} from './pr-refresh-pacing'
import {
  broadcastRefreshEvent,
  isRefreshKeyVisible,
  nextRefreshSequence,
  nextVisibleErrorRetryAt,
  noteManualRetryGate,
  notifyRefreshOutcome,
  recordRefreshQueueDiagnostic,
  refreshQueue,
  resetRefreshRetryState,
  withErrorSchedule,
  type QueueEntry
} from './pr-refresh-queue-state'
import { scheduleVisiblePRRefreshFollowUp } from './pr-refresh-visible-follow-up'

let draining = false
let drainTimer: NodeJS.Timeout | undefined

function nextQueuedWakeDelay(excludedKey: string): number | null {
  const now = Date.now()
  let nextDelay = Number.POSITIVE_INFINITY
  for (const entry of refreshQueue.values()) {
    if (entry.key === excludedKey) {
      continue
    }
    const delay = entry.dueAt > now ? entry.dueAt - now : refreshEntryPacingDelay(entry)
    nextDelay = Math.min(nextDelay, delay)
  }
  return Number.isFinite(nextDelay) ? Math.max(0, nextDelay) : null
}

export function schedulePRRefreshDrain(delay = 0): void {
  clearTimeout(drainTimer)
  drainTimer = setTimeout(() => {
    drainTimer = undefined
    void drainPRRefreshQueue()
  }, delay)
}

function queuedEntriesByPriority(): QueueEntry[] {
  const now = Date.now()
  return Array.from(refreshQueue.values()).sort((a, b) => {
    const aReady = a.dueAt <= now
    const bReady = b.dueAt <= now
    if (aReady && bReady) {
      return b.priority - a.priority || activeRefreshOrder(a, b) || a.dueAt - b.dueAt
    }
    if (aReady !== bReady) {
      return aReady ? -1 : 1
    }
    return a.dueAt - b.dueAt || b.priority - a.priority
  })
}

async function applyBackgroundExecutionGate(next: QueueEntry): Promise<boolean> {
  const retryAt = await getGitHubRefreshRateLimitRetryAt(next.candidate, true)
  if (retryAt !== null) {
    refreshQueue.set(next.key, { ...next, dueAt: retryAt })
    broadcastRefreshEvent({
      aliases: Array.from(next.aliases.values()),
      reason: next.reason,
      status: 'paused',
      pausedUntil: retryAt,
      skippedReason: 'rate-limit'
    })
    schedulePRRefreshDrain(Math.max(1_000, retryAt - Date.now()))
    return false
  }
  if (isBudgetedQueueEntry(next)) {
    noteBackgroundRefreshStart()
  }
  if (next.reason === 'active') {
    noteActiveRefreshStart(next)
  }
  return true
}

async function runQueuedRefresh(next: QueueEntry): Promise<void> {
  refreshQueue.delete(next.key)
  const aliases = Array.from(next.aliases.values())
  const skippedReason = validateCandidate(next.candidate)
  if (skippedReason) {
    recordRefreshQueueDiagnostic('skipped', next.reason, skippedReason)
    broadcastRefreshEvent({ aliases, reason: next.reason, status: 'skipped', skippedReason })
    return
  }
  if (next.reason === 'visible' && !isRefreshKeyVisible(next.key)) {
    resetRefreshRetryState(next.key)
    broadcastRefreshEvent({
      aliases,
      reason: next.reason,
      status: 'skipped',
      skippedReason: 'fresh'
    })
    return
  }
  const requestSequence = nextRefreshSequence()
  const requestStartedAt = Date.now()
  broadcastRefreshEvent(
    { aliases, reason: next.reason, status: 'in-flight', requestStartedAt },
    requestSequence
  )
  if (isBackground(next.reason) && !(await applyBackgroundExecutionGate(next))) {
    return
  }
  const outcome = await queryGitHubPullRequest(next.candidate)
  let plannedRetryAt: number | undefined
  let broadcastOutcome = outcome
  if (outcome.kind === 'upstream-error' && isRefreshKeyVisible(next.key)) {
    plannedRetryAt = nextVisibleErrorRetryAt(next.key)
    broadcastOutcome = withErrorSchedule(outcome, plannedRetryAt)
  }
  notifyRefreshOutcome(next.candidate, outcome)
  noteManualRetryGate(next.key, broadcastOutcome)
  broadcastRefreshEvent(
    { aliases, reason: next.reason, outcome: broadcastOutcome, requestStartedAt },
    requestSequence
  )
  scheduleVisiblePRRefreshFollowUp(
    next.key,
    next.candidate,
    outcome,
    next.priority,
    aliases,
    schedulePRRefreshDrain,
    next.windowId,
    { plannedRetryAt }
  )
}

async function drainPRRefreshQueue(): Promise<void> {
  if (draining) {
    return
  }
  draining = true
  try {
    while (refreshQueue.size > 0) {
      let next = queuedEntriesByPriority()[0]
      const waitMs = next.dueAt - Date.now()
      if (waitMs > 0) {
        schedulePRRefreshDrain(waitMs)
        return
      }
      let delay = refreshEntryPacingDelay(next)
      if (delay > 0) {
        const runnable = queuedEntriesByPriority().find(
          (entry) => entry.dueAt <= Date.now() && refreshEntryPacingDelay(entry) === 0
        )
        if (runnable && runnable.key !== next.key) {
          next = runnable
          delay = 0
        } else {
          if (
            next.reason === 'active' &&
            nextActiveBurstDelay(next) > 0 &&
            !next.activeDelayNotified
          ) {
            next.activeDelayNotified = true
            broadcastRefreshEvent({
              aliases: Array.from(next.aliases.values()),
              reason: next.reason,
              status: 'queued'
            })
          }
          if (isBudgetedQueueEntry(next) && nextBackgroundBudgetDelay() > 0) {
            recordRefreshQueueDiagnostic('background-pause', next.reason)
          }
          schedulePRRefreshDrain(Math.min(delay, nextQueuedWakeDelay(next.key) ?? delay))
          return
        }
      }
      await runQueuedRefresh(next)
    }
  } finally {
    draining = false
  }
}

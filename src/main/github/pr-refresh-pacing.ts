import type { QueueEntry } from './pr-refresh-queue-state'
import { isBudgetedBackground } from './pr-refresh-candidate-policy'

const BACKGROUND_BUDGET_WINDOW_MS = 5 * 60_000
const MIN_BACKGROUND_SPACING_MS = 10_000
const BACKGROUND_BUDGET_MAX = 20
const ACTIVE_BURST_WINDOW_MS = 30_000
const ACTIVE_BURST_MAX = 3

const backgroundStarts: number[] = []
const activeStartsByScope = new Map<string, number[]>()
let lastBackgroundStartAt = 0

export function isBudgetedQueueEntry(entry: QueueEntry): boolean {
  return isBudgetedBackground(entry.reason) && entry.bypassBackgroundBudget !== true
}

export function noteBackgroundRefreshStart(): void {
  const now = Date.now()
  lastBackgroundStartAt = now
  backgroundStarts.push(now)
  while (backgroundStarts.length > 0 && now - backgroundStarts[0] > BACKGROUND_BUDGET_WINDOW_MS) {
    backgroundStarts.shift()
  }
}

export function nextBackgroundBudgetDelay(): number {
  const now = Date.now()
  while (backgroundStarts.length > 0 && now - backgroundStarts[0] > BACKGROUND_BUDGET_WINDOW_MS) {
    backgroundStarts.shift()
  }
  const spacingDelay =
    lastBackgroundStartAt > 0
      ? Math.max(0, MIN_BACKGROUND_SPACING_MS - (now - lastBackgroundStartAt))
      : 0
  const windowDelay =
    backgroundStarts.length < BACKGROUND_BUDGET_MAX
      ? 0
      : Math.max(1_000, BACKGROUND_BUDGET_WINDOW_MS - (now - backgroundStarts[0]))
  return Math.max(spacingDelay, windowDelay)
}

function activeBurstScope(entry: QueueEntry): string {
  const runtimeScope = entry.candidate.connectionId
    ? `ssh:${entry.candidate.connectionId}`
    : `local:${entry.candidate.localGitOptions?.wslDistro ?? 'host'}`
  return `${entry.windowId ?? 'global'}::${runtimeScope}`
}

function pruneActiveStarts(scope: string, now: number): number[] {
  const activeStarts = activeStartsByScope.get(scope) ?? []
  while (activeStarts.length > 0 && now - activeStarts[0] >= ACTIVE_BURST_WINDOW_MS) {
    activeStarts.shift()
  }
  if (activeStarts.length === 0) {
    activeStartsByScope.delete(scope)
  } else {
    activeStartsByScope.set(scope, activeStarts)
  }
  return activeStarts
}

export function nextActiveBurstDelay(entry: QueueEntry): number {
  const now = Date.now()
  const activeStarts = pruneActiveStarts(activeBurstScope(entry), now)
  if (activeStarts.length < ACTIVE_BURST_MAX) {
    return 0
  }
  return Math.max(1, ACTIVE_BURST_WINDOW_MS - (now - activeStarts[0]))
}

export function noteActiveRefreshStart(entry: QueueEntry): void {
  const now = Date.now()
  const scope = activeBurstScope(entry)
  const activeStarts = pruneActiveStarts(scope, now)
  activeStarts.push(now)
  activeStartsByScope.set(scope, activeStarts)
}

export function activeRefreshOrder(a: QueueEntry, b: QueueEntry): number {
  if (a.reason !== 'active' || b.reason !== 'active') {
    return 0
  }
  if (activeBurstScope(a) !== activeBurstScope(b)) {
    return 0
  }
  return b.queuedAt - a.queuedAt
}

export function refreshEntryPacingDelay(entry: QueueEntry): number {
  const activeBurstDelay = entry.reason === 'active' ? nextActiveBurstDelay(entry) : 0
  if (activeBurstDelay > 0) {
    return activeBurstDelay
  }
  return isBudgetedQueueEntry(entry) ? nextBackgroundBudgetDelay() : 0
}

export function clearActiveRefreshBurstWindow(windowId: number): void {
  const windowPrefix = `${windowId}::`
  for (const scope of Array.from(activeStartsByScope.keys())) {
    if (scope.startsWith(windowPrefix)) {
      activeStartsByScope.delete(scope)
    }
  }
}

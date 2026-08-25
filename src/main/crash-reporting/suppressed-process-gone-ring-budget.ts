// Coalescing bounds a *repeating* suppressed exit to one breadcrumb, but it is
// per-key: once every Chromium utility service suppresses by default, one OOM
// sweep or shutdown race churns a whole population of distinct services and each
// one claims its own ring slot. Thirty such exits fill the 30-entry ring and
// evict the entire pre-crash trail -- the exact blind spot coalescing exists to
// prevent. So cap the slots suppressed churn may hold and fold the rest into a
// single overflow slot, which keeps counting them via `suppressedSinceLast`.

// A fifth of the 30-entry ring; the last of the six is the overflow slot.
const SUPPRESSED_RING_SLOT_BUDGET = 6
// Leading space: coalesce keys are JSON arrays, so this can never collide.
const OVERFLOW_COALESCE_KEY = ' process-gone-suppressed-overflow'

// Why monotonic: wall-clock corrections must not stretch or collapse the window.
const monotonicNow = (): number => performance.now()

let windowStartedAtMs = Number.NEGATIVE_INFINITY
let slotKeys = new Set<string>()

/**
 * Maps a suppressed process-gone coalesce key onto the key it may actually use.
 * Returns the key unchanged while the budget has room, and the shared overflow
 * key once it does not, so a service-population burst costs a bounded number of
 * ring slots instead of one per service.
 */
export function budgetedSuppressedCoalesceKey(coalesceKey: string, windowMs: number): string {
  const now = monotonicNow()
  if (now - windowStartedAtMs >= windowMs) {
    windowStartedAtMs = now
    slotKeys = new Set()
  }
  if (slotKeys.has(coalesceKey)) {
    return coalesceKey
  }
  if (slotKeys.size < SUPPRESSED_RING_SLOT_BUDGET - 1) {
    slotKeys.add(coalesceKey)
    return coalesceKey
  }
  return OVERFLOW_COALESCE_KEY
}

export function isSuppressedOverflowCoalesceKey(coalesceKey: string): boolean {
  return coalesceKey === OVERFLOW_COALESCE_KEY
}

export function resetSuppressedProcessGoneRingBudgetForTest(): void {
  windowStartedAtMs = Number.NEGATIVE_INFINITY
  slotKeys = new Set()
}

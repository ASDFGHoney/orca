/**
 * A try/catch around an async setState is not an error boundary. When React's nested-update
 * limit trips (#185), the throw surfaces wherever the next setState happened to run — often
 * inside an awaited continuation whose catch was written for network failures. Swallowing it
 * there hides the runaway loop, paints its message as ordinary UI copy, and lets React's
 * module-global counter reset to 0 so the loop re-arms and throws again on a different fiber.
 *
 * React cannot be told about an error raised outside its call stack, so containment here means
 * re-reporting with the *catching site's* identity — the only attribution #185 has, since any
 * boundary that catches it names a bystander picked by commit order.
 */

import { RENDERER_ERROR_DEDUPE_MS } from '../../../shared/crash-reporting'
import { isReactUpdateDepthError } from '../../../shared/react-update-depth-attribution'
import { reportReactErrorBoundaryCrash } from './react-error-boundary-reporting'

// Marks the report as a swallowing catch rather than a mounted boundary; boundaryId caps at 120 chars.
const ASYNC_CATCH_BOUNDARY_PREFIX = 'async-catch:'

// The report-key windows downstream expire on the same clock, so a re-escalation is never dropped as
// a duplicate; `observedAt` below keeps the awaits in between from shifting them apart.
const ESCALATION_SUPPRESSION_MS = RENDERER_ERROR_DEDUPE_MS

const lastEscalationAtBySiteId = new Map<string, number>()
const pendingEscalations = new Set<Promise<void>>()

/**
 * Returns true when `error` is React's nested-update-limit throw, after logging it and routing it
 * to the crash reporter and the host error handler. Callers should then bail out of their catch rather than
 * apply their normal failure handling: the message is not a user-facing status, and the extra
 * setState calls would feed the same loop.
 *
 * Returns false — and does nothing — for every other error, so expected failures keep their path.
 *
 * `siteId` names the catch, e.g. `settings.ReleaseChannelSection.loadBuilds`.
 */
export function escalateReactUpdateDepthError(error: unknown, siteId: string): boolean {
  if (!isReactUpdateDepthError(error)) {
    return false
  }
  // Why throttled per site: the loop that produced this re-enters the same catch thousands of times a
  // second. Why not once per site: a later, unrelated runaway at the same catch must not be silent.
  const now = Date.now()
  const sinceLastEscalation = now - (lastEscalationAtBySiteId.get(siteId) ?? -Infinity)
  // A backwards clock jump reads as negative; escalate rather than suppress until the clock catches up.
  if (sinceLastEscalation >= 0 && sinceLastEscalation < ESCALATION_SUPPRESSION_MS) {
    return true
  }
  forgetExpiredEscalations(now)
  lastEscalationAtBySiteId.set(siteId, now)
  try {
    // Why unconditional: the web client stubs crash reporting to a no-op, so without this the
    // guard would trade a mislabeled digest for total silence. Throttled with the report.
    console.error(
      `[react-update-depth] React #185 (nested update limit) surfaced in the catch at ${siteId}; that site is a bystander, not the cause:`,
      error
    )
    trackEscalation(
      reportReactErrorBoundaryCrash({
        boundaryId: `${ASYNC_CATCH_BOUNDARY_PREFIX}${siteId}`,
        // No boundary caught this, so no boundary surface describes it; siteId carries the identity.
        surface: 'app-root',
        error,
        observedAt: now,
        // Off by default so a recurring boundary crash cannot re-open the modal crash dialog; this
        // site self-throttles on the same window, so opting in re-reports at most once per window.
        repeatAfterDedupeWindow: true
      })
    )
    dispatchToHostErrorHandler(error, siteId)
  } catch (escalationError) {
    // A guard that throws would replace the loop with a second, less informative failure.
    console.warn('[react-update-depth] Failed to escalate a swallowed #185:', escalationError)
  }
  return true
}

function forgetExpiredEscalations(now: number): void {
  for (const [expiredSiteId, escalatedAt] of lastEscalationAtBySiteId) {
    if (now - escalatedAt >= ESCALATION_SUPPRESSION_MS) {
      lastEscalationAtBySiteId.delete(expiredSiteId)
    }
  }
}

function trackEscalation(escalation: Promise<void>): void {
  pendingEscalations.add(escalation)
  void escalation.catch(() => undefined).finally(() => pendingEscalations.delete(escalation))
}

/** Re-raises on the host so global renderer diagnostics see it; a synchronous rethrow would be re-swallowed. */
function dispatchToHostErrorHandler(error: unknown, siteId: string): void {
  if (typeof window === 'undefined' || typeof ErrorEvent !== 'function') {
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  window.dispatchEvent(
    new ErrorEvent('error', {
      error,
      message: `[${ASYNC_CATCH_BOUNDARY_PREFIX}${siteId}] ${message}`
    })
  )
}

/** Join point for tests: reporting is deliberately fire-and-forget in the app. */
export async function flushReactUpdateDepthEscalationsForTest(): Promise<void> {
  await Promise.allSettled(pendingEscalations)
}

export function resetReactUpdateDepthEscalationForTest(): void {
  lastEscalationAtBySiteId.clear()
  pendingEscalations.clear()
}

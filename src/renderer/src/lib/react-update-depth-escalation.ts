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

import { isReactUpdateDepthError } from '../../../shared/react-update-depth-attribution'
import { reportReactErrorBoundaryCrash } from './react-error-boundary-reporting'

// Marks the report as a swallowing catch rather than a mounted boundary; boundaryId caps at 120 chars.
const ASYNC_CATCH_BOUNDARY_PREFIX = 'async-catch:'

const escalatedSiteIds = new Set<string>()
const pendingEscalations = new Set<Promise<void>>()

/**
 * Returns true when `error` is React's nested-update-limit throw, after routing it to the crash
 * reporter and the host error handler. Callers should then bail out of their catch rather than
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
  // Why once per site: the loop that produced this re-enters the same catch thousands of times a second.
  if (escalatedSiteIds.has(siteId)) {
    return true
  }
  escalatedSiteIds.add(siteId)
  try {
    trackEscalation(
      reportReactErrorBoundaryCrash({
        boundaryId: `${ASYNC_CATCH_BOUNDARY_PREFIX}${siteId}`,
        // No boundary caught this, so no boundary surface describes it; siteId carries the identity.
        surface: 'app-root',
        error
      })
    )
    dispatchToHostErrorHandler(error, siteId)
  } catch (escalationError) {
    // A guard that throws would replace the loop with a second, less informative failure.
    console.warn('[react-update-depth] Failed to escalate a swallowed #185:', escalationError)
  }
  return true
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
  escalatedSiteIds.clear()
  pendingEscalations.clear()
}

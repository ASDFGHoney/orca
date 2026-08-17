import type { PRRefreshOutcome } from '../../../shared/github/pull-request-refresh-types'
import { classifyPRRefreshError, safePRRefreshErrorMessage } from '../pr-refresh-error-classification'
import { classifyGhError } from '../gh-utils'
// Why: import from the lightweight module (not ./gh-utils) so tests mocking gh-utils still get the real functions.
import { extractExecError, parseRetryAfterMs } from '../../git/exec-error'
export function isNoPullRequestError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /no pull requests? found|could not find.*pull request/i.test(message)
}

export function isNotFoundGhError(err: unknown): boolean {
  const stderr = err instanceof Error ? err.message : String(err)
  return classifyGhError(stderr).type === 'not_found'
}

export function shouldStopAfterExactLookupError(err: unknown): boolean {
  const stderr = err instanceof Error ? err.message : String(err)
  const type = classifyGhError(stderr).type
  return type !== 'not_found'
}

export function prRefreshUpstreamError(
  err: unknown
): Extract<PRRefreshOutcome, { kind: 'upstream-error' }> {
  const errorType = classifyPRRefreshError(err)
  const outcome: Extract<PRRefreshOutcome, { kind: 'upstream-error' }> = {
    kind: 'upstream-error',
    errorType,
    message: safePRRefreshErrorMessage(errorType),
    fetchedAt: Date.now()
  }
  // Why: a Retry-After is a real cooldown — surface it as the retry schedule so the renderer doesn't retry into another 429.
  if (errorType === 'rate_limited') {
    const retryAfterMs = parseRetryAfterMs(extractExecError(err).stderr)
    if (retryAfterMs !== null && retryAfterMs > 0) {
      const retryAt = Date.now() + retryAfterMs
      outcome.nextAutoRetryAt = retryAt
      outcome.retryDisabledUntil = retryAt
    }
  }
  return outcome
}

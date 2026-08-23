import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'
import type { AmphetamineAvailability } from './macos-amphetamine-availability'
import type { AmphetamineFailureBackoff } from './macos-amphetamine-failure-backoff'
import type { AmphetamineHold } from './macos-amphetamine-hold'
import { classifyAmphetamineFailure, type OsascriptResult } from './macos-amphetamine-session'

type Logger = Pick<Console, 'debug' | 'warn'>

export type AmphetamineFailurePolicyOptions = {
  availability: AmphetamineAvailability
  backoff: AmphetamineFailureBackoff
  hold: AmphetamineHold
  logger: Logger
  /** The engine became unusable: stop any periodic work. */
  onUnusable: () => void
  onUnavailable: (reason: AmphetamineUnavailableReason) => void
  onUnexpectedFailure: () => void
}

/**
 * Decides what a failed Amphetamine command means.
 *
 * Separate from the assertion because two different questions live here and the
 * assertion is about neither: whether the engine is usable at all, and how hard
 * to retry. Both have to hold even when the caller re-enters through a service
 * refresh, which is why every path records backoff before notifying.
 */
export class AmphetamineFailurePolicy {
  private readonly options: AmphetamineFailurePolicyOptions

  constructor(options: AmphetamineFailurePolicyOptions) {
    this.options = options
  }

  /** Classifies the result, so a missing app or refused grant is terminal rather than retried. */
  reportScriptFailure(step: string, reason: string, result: OsascriptResult): void {
    const unavailable = classifyAmphetamineFailure(result)
    if (unavailable) {
      this.markUnavailable(unavailable, reason, result)
      return
    }
    this.reportFailure(`${step}:${String(result.code)}`, reason, {
      code: result.code,
      stderr: result.stderr.trim(),
      timedOut: result.timedOut
    })
  }

  reportFailure(failureKey: string, reason: string, details: unknown): void {
    this.options.hold.markStale()
    this.options.backoff.record(failureKey, reason, details)
    this.options.onUnexpectedFailure()
  }

  markUnavailable(
    unavailableReason: AmphetamineUnavailableReason,
    reason: string,
    details: unknown
  ): void {
    const { availability, backoff, hold, logger, onUnusable, onUnavailable } = this.options
    const isNewVerdict = availability.mark(unavailableReason)
    hold.markStale()
    if (unavailableReason === 'not-installed') {
      // No app means no session, so the hold is stale bookkeeping.
      hold.release()
    }
    onUnusable()
    // Throttle even a repeat verdict. An unusable engine is still re-entered by
    // every service refresh, and without this each entry spends an Apple event.
    backoff.record(`unavailable:${unavailableReason}`, reason, details)
    if (!isNewVerdict) {
      return
    }
    logger.warn('[agent-awake] Amphetamine is unavailable', {
      reason,
      unavailableReason,
      details
    })
    onUnavailable(unavailableReason)
  }
}

import type { AmphetamineHold } from './macos-amphetamine-hold'
import { AMPHETAMINE_RELEASE_SCRIPT, type RunOsascriptSync } from './macos-amphetamine-session'

type Logger = Pick<Console, 'debug' | 'warn'>

/**
 * End Orca's Amphetamine session on the way out, synchronously.
 *
 * Quit tears the event loop down before an awaited osascript could report back,
 * and a missed `end session` leaves the Mac awake indefinitely — so this is the
 * one place the main thread is deliberately blocked. The script re-tests the
 * session shape immediately before ending, which is the narrowest window this
 * API allows; it is not a transaction (see
 * docs/reference/macos-keep-awake-engines.md).
 *
 * Returns whether the session is known to be gone. False means it may still be
 * running and nothing will retry, because the caller is being disposed.
 */
export function releaseAmphetamineSessionSync(options: {
  logger: Logger
  reason: string
  runOsascriptSync: RunOsascriptSync
}): boolean {
  const { logger, reason, runOsascriptSync } = options
  try {
    const result = runOsascriptSync(AMPHETAMINE_RELEASE_SCRIPT)
    if (result.code !== 0) {
      logger.warn('[agent-awake] failed to end Amphetamine session', { reason, result })
      return false
    }
    return true
  } catch (error) {
    logger.warn('[agent-awake] failed to end Amphetamine session', { reason, error })
    return false
  }
}

/**
 * Release whatever Orca may be holding, on the way out.
 *
 * Runs when a session is held *or* when an acquire is still in flight: quit can
 * tear the event loop down before an awaited osascript reports, so an acquire
 * already sent may have created a session nothing will ever hear about. Running
 * the release when uncertain is safe because it verifies shape first.
 *
 * On failure the hold is kept and marked stale rather than cleared. Nothing can
 * retry after disposal, and reporting nothing held would claim a cleanup that
 * did not happen.
 */
export function disposeAmphetamineSession(options: {
  hold: AmphetamineHold
  hadAcquireInFlight: boolean
  logger: Logger
  runOsascriptSync: RunOsascriptSync
}): void {
  const { hold, hadAcquireInFlight, logger, runOsascriptSync } = options
  if (!hold.isOwned() && !hadAcquireInFlight) {
    hold.release()
    return
  }
  if (releaseAmphetamineSessionSync({ logger, reason: 'dispose', runOsascriptSync })) {
    hold.release()
    return
  }
  hold.own()
  hold.markStale()
  logger.warn('[agent-awake] left an Amphetamine session running at quit')
}

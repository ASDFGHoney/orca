import type { AmphetamineHold } from './macos-amphetamine-hold'
import {
  AMPHETAMINE_RELEASE_SCRIPT,
  parseReleaseOutcome,
  type AmphetamineReleaseOutcome,
  type RunOsascriptSync
} from './macos-amphetamine-session'

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
 * Returns what the script did, or null when the command itself failed — in which
 * case the session may still be running and nothing will retry, because the
 * caller is being disposed.
 */
export function releaseAmphetamineSessionSync(options: {
  logger: Logger
  reason: string
  runOsascriptSync: RunOsascriptSync
}): AmphetamineReleaseOutcome | null {
  const { logger, reason, runOsascriptSync } = options
  try {
    const result = runOsascriptSync(AMPHETAMINE_RELEASE_SCRIPT)
    if (result.code !== 0) {
      logger.warn('[agent-awake] failed to end Amphetamine session', { reason, result })
      return null
    }
    return parseReleaseOutcome(result.stdout)
  } catch (error) {
    logger.warn('[agent-awake] failed to end Amphetamine session', { reason, error })
    return null
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
  let outcome = releaseAmphetamineSessionSync({ logger, reason: 'dispose', runOsascriptSync })
  if (hadAcquireInFlight) {
    // Whatever the first pass did. Aborting an in-flight acquire only *requests*
    // a kill, and the Apple event it may already have sent is processed
    // asynchronously by Amphetamine — so a new session can appear after a first
    // pass that reported 'ended' just as easily as after one that reported
    // 'gone'. Gating on 'gone' missed exactly that: end the existing session,
    // then have the acquire create another with nothing left to clean it up.
    // The spawn supplies the delay, and the script ends nothing when there is
    // nothing of Orca's to end.
    outcome = releaseAmphetamineSessionSync({
      logger,
      reason: 'dispose-acquire-race',
      runOsascriptSync
    })
  }
  if (outcome !== null) {
    hold.release()
    return
  }
  hold.own()
  hold.markStale()
  logger.warn('[agent-awake] left an Amphetamine session running at quit')
}

import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'
import { AmphetamineAvailability } from './macos-amphetamine-availability'
import { AmphetamineHold, type AmphetamineHoldKind } from './macos-amphetamine-hold'
import { AmphetamineReconcileTimer } from './macos-amphetamine-reconcile-timer'
import { AmphetamineFailureBackoff } from './macos-amphetamine-failure-backoff'
import { AmphetamineFailurePolicy } from './macos-amphetamine-failure-policy'
import {
  disposeAmphetamineSession,
  releaseAmphetamineSessionSync
} from './macos-amphetamine-quit-release'
import {
  AMPHETAMINE_ACQUIRE_SCRIPT,
  AMPHETAMINE_RELEASE_SCRIPT,
  classifyAmphetamineFailure,
  parseAcquireOutcome,
  parseReleaseOutcome,
  runOsascriptSyncWithRunProcess,
  runOsascriptWithRunProcess,
  type OsascriptResult,
  type RunOsascript,
  type RunOsascriptSync
} from './macos-amphetamine-session'

export const MACOS_AMPHETAMINE_ASSERTION_RETRY_MS = 30_000
/** A session Orca adopted can expire on its own, so re-check while we depend on it. */
export const MACOS_AMPHETAMINE_RECONCILE_MS = 30_000

type Logger = Pick<Console, 'debug' | 'warn'>

/**
 * `owned` = matches the shape Orca creates, so Orca is responsible for ending it.
 * Usually a session Orca started, but Amphetamine exposes no identity, so the
 * shape match cannot prove that — see macos-keep-awake-engines.md.
 * `adopted` = does not match Orca's shape, so it is someone else's to end and
 * Orca must not touch it. It may also be a timed session that expires on its own.
 */
type MacosAmphetamineSleepAssertionOptions = {
  logger?: Logger
  now?: () => number
  onUnexpectedFailure?: (reason: string) => void
  onUnavailable?: (reason: AmphetamineUnavailableReason) => void
  platform?: NodeJS.Platform
  reconcileMs?: number
  runOsascript?: RunOsascript
  runOsascriptSync?: RunOsascriptSync
}

/**
 * Holds a wake assertion through Amphetamine instead of `caffeinate`.
 *
 * Amphetamine's session is global and singular — `start new session` ends whatever
 * was running, including the user's Triggers — so every write here is preceded by
 * a read in the same script. A session that is not Orca-shaped is adopted rather
 * than replaced, and a session is only ended after it was seen to match the shape
 * Orca creates.
 *
 * Those are checks, not guarantees: the read and the write are separate Apple
 * events and Amphetamine offers no compare-and-swap, so a change landing between
 * them can still be destroyed. See docs/reference/macos-keep-awake-engines.md for
 * what this design can and cannot promise.
 */
export class MacosAmphetamineSleepAssertion {
  private readonly logger: Logger
  private readonly now: () => number
  private readonly onUnexpectedFailure: (reason: string) => void
  private readonly onUnavailable: (reason: AmphetamineUnavailableReason) => void
  private readonly platform: NodeJS.Platform
  private readonly reconcileMs: number
  private readonly runOsascript: RunOsascript
  private readonly runOsascriptSync: RunOsascriptSync
  private readonly backoff: AmphetamineFailureBackoff
  private readonly failures: AmphetamineFailurePolicy
  private desired: 'started' | 'stopped' = 'stopped'
  private readonly hold = new AmphetamineHold()
  /** Aborts an in-flight acquire at quit; null when none is running. */
  private acquireAbort: AbortController | null = null
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly availability = new AmphetamineAvailability()
  private readonly reconcileTimer = new AmphetamineReconcileTimer()

  constructor(options: MacosAmphetamineSleepAssertionOptions = {}) {
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
    this.onUnexpectedFailure = options.onUnexpectedFailure ?? (() => {})
    this.onUnavailable = options.onUnavailable ?? (() => {})
    this.platform = options.platform ?? process.platform
    this.reconcileMs = options.reconcileMs ?? MACOS_AMPHETAMINE_RECONCILE_MS
    this.runOsascript = options.runOsascript ?? runOsascriptWithRunProcess
    this.runOsascriptSync = options.runOsascriptSync ?? runOsascriptSyncWithRunProcess
    this.backoff = new AmphetamineFailureBackoff({
      logger: this.logger,
      now: this.now,
      retryMs: MACOS_AMPHETAMINE_ASSERTION_RETRY_MS,
      onRetryDue: () => this.onUnexpectedFailure('macos-amphetamine-assertion-retry')
    })
    this.failures = new AmphetamineFailurePolicy({
      availability: this.availability,
      backoff: this.backoff,
      hold: this.hold,
      logger: this.logger,
      onUnusable: () => this.stopReconcileTimer(),
      onUnavailable: (unavailableReason) => this.onUnavailable(unavailableReason),
      onUnexpectedFailure: () => this.onUnexpectedFailure('macos-amphetamine-assertion-failure')
    })
  }

  start(reason: string): void {
    if (this.platform !== 'darwin' || this.disposed || this.availability.isUnavailable()) {
      return
    }
    this.desired = 'started'
    this.startReconcileTimer()
    this.enqueue(reason)
  }

  stop(reason: string): void {
    if (this.platform !== 'darwin' || this.disposed) {
      return
    }
    this.desired = 'stopped'
    this.stopReconcileTimer()
    // Deliberately not resetting the backoff: a failed release refreshes the
    // service, which stops again, so resetting here would re-arm an unthrottled
    // probe loop. The retry timer drives the next attempt instead.
    this.enqueue(reason)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.desired = 'stopped'
    this.stopReconcileTimer()
    this.backoff.reset()
    // Kill any in-flight acquire before releasing. Otherwise the release can run
    // first, report 'gone', and the acquire can then create a session whose await
    // continuation never runs because teardown got there — leaking it silently.
    const hadAcquireInFlight = this.acquireAbort !== null
    this.acquireAbort?.abort()
    this.acquireAbort = null
    disposeAmphetamineSession({
      hold: this.hold,
      hadAcquireInFlight,
      logger: this.logger,
      runOsascriptSync: this.runOsascriptSync
    })
  }

  /**
   * Forget a previous unavailable verdict so the engine is tried again.
   *
   * Without this a refused Automation grant pins Orca to caffeinate until
   * relaunch, even though the tooltip tells the user how to fix it.
   */
  clearUnavailable(): void {
    if (this.availability.clear()) {
      this.backoff.reset()
    }
  }

  /** True once Amphetamine proved unusable, so callers can fall back to caffeinate. */
  isUnavailable(): boolean {
    return this.availability.isUnavailable()
  }

  getUnavailableReason(): AmphetamineUnavailableReason | null {
    return this.availability.get()
  }

  /**
   * The classification, which outlives a failed attempt so cleanup can still
   * happen. Non-null does NOT mean a session is holding.
   */
  getHold(): AmphetamineHoldKind {
    return this.hold.get()
  }

  private enqueue(reason: string, recheck = false): void {
    this.queue = this.queue.then(() => this.reconcile(reason, recheck)).catch(() => {})
  }

  private async reconcile(reason: string, recheck = false): Promise<void> {
    // Bounded because `desired` can flip while an Apple event is in flight.
    for (let pass = 0; pass < 4; pass += 1) {
      if (this.disposed) {
        return
      }
      if (this.desired === 'started') {
        if (!(await this.ensureSession(reason, recheck))) {
          return
        }
      } else if (!(await this.releaseSession(reason))) {
        return
      }
      // .get(), not the hold object itself — which is always truthy.
      if (this.desired === (this.hold.get() ? 'started' : 'stopped')) {
        return
      }
    }
  }

  /** Returns false when it could not make progress, so the caller stops looping. */
  private async ensureSession(reason: string, recheck = false): Promise<boolean> {
    if (this.availability.isUnavailable()) {
      return false
    }
    // isLive, not just held: a classification retained after a failure is not
    // evidence anything is holding, and that is when a retry is worth an Apple
    // event. Otherwise only the periodic re-check spends one.
    if (this.hold.isLive() && !recheck) {
      return true
    }
    // Gate before the Apple event: a failure refreshes the service, which starts
    // this again, so an ungated attempt is an unthrottled osascript loop.
    if (this.backoff.isSuppressed()) {
      return false
    }
    let result: OsascriptResult
    const abort = new AbortController()
    this.acquireAbort = abort
    try {
      result = await this.runOsascript(AMPHETAMINE_ACQUIRE_SCRIPT, abort.signal)
    } catch (error) {
      this.acquireAbort = null
      this.claimIndeterminateAcquire()
      this.failures.reportFailure('acquire-spawn-error', reason, error)
      return false
    }
    this.acquireAbort = null
    if (result.code !== 0 || result.timedOut) {
      // A timeout or an unclassified error cannot tell us whether the write
      // landed; a classified one can (no app, or no permission to send it).
      if (result.timedOut || !classifyAmphetamineFailure(result)) {
        this.claimIndeterminateAcquire()
      }
      this.failures.reportScriptFailure('acquire', reason, result)
      return false
    }
    const outcome = parseAcquireOutcome(result.stdout)
    if (!outcome) {
      // The script ran and may well have started a session before producing
      // output we cannot read.
      this.claimIndeterminateAcquire()
      this.failures.reportFailure('acquire:unparseable', reason, { stdout: result.stdout.trim() })
      return false
    }
    if (outcome === 'foreign') {
      if (this.disposed) {
        // Nothing to end — the script left the foreign session alone — but
        // installing a hold and firing listeners after teardown is a lie.
        return false
      }
      // Someone else's session already keeps the Mac awake, and the script left
      // it untouched. Adopting is both sufficient and the only safe option.
      this.hold.adopt()

      this.backoff.reset()
      return true
    }
    if (outcome === 'orca-shaped' || outcome === 'started') {
      if (this.disposed) {
        // Quit landed while the Apple event was in flight; nothing runs after
        // this, so the session has to go now. Reclaims need this as much as
        // fresh starts — both leave an indefinite session behind otherwise.
        const outcome = releaseAmphetamineSessionSync({
          logger: this.logger,
          reason: 'dispose-race',
          runOsascriptSync: this.runOsascriptSync
        })
        if (outcome === null) {
          // Record it rather than reporting null: nothing can retry, and a
          // silent null would claim a session was cleaned up that was not.
          this.hold.own()
          this.hold.markStale()
          this.logger.warn('[agent-awake] left an Amphetamine session running at quit', {
            reason: 'dispose-race'
          })
        }
        return false
      }
      this.hold.own()

      this.backoff.reset()
      return true
    }
    return false
  }

  /**
   * Keep cleanup responsibility for an acquire whose outcome is unknown.
   *
   * `start new session` may have taken effect before the command failed. Without
   * this the hold stays null, a later stop does nothing and quit skips its
   * release, so an indefinite session leaks. Claiming it is safe because every
   * release verifies the shape first and ends nothing that is not Orca's; it is
   * marked stale so it never counts as coverage.
   */
  private claimIndeterminateAcquire(): void {
    // Unconditionally, including over an existing 'adopted' classification. A
    // periodic re-acquire runs against a live adopted hold, and the foreign
    // session it adopted may have expired just before the script looked — so the
    // command can create a session of Orca's and then fail to report it. Leaving
    // the hold 'adopted' would make every later release skip the command and
    // strand that session. Claiming it costs nothing if the foreign session did
    // survive: the release script re-checks the shape and ends nothing.
    this.hold.own()
    this.hold.markStale()
  }

  private async releaseSession(reason: string): Promise<boolean> {
    if (this.hold.get() === null) {
      return true
    }
    if (this.hold.get() === 'adopted') {
      // Never end a session whose shape says it is not Orca's.
      this.hold.release()
      return true
    }
    if (this.backoff.isSuppressed()) {
      return false
    }
    if (this.disposed) {
      // dispose() owns the synchronous end; a second one here could land after
      // the user has started a session of their own.
      return false
    }
    // Stop vouching before the command goes out. The session is about to end, so
    // a router that still read this hold as live would drop its caffeinate
    // stand-in and cover nothing until a re-acquire completes.
    this.hold.markStale()
    let result: OsascriptResult
    try {
      result = await this.runOsascript(AMPHETAMINE_RELEASE_SCRIPT)
    } catch (error) {
      this.failures.reportFailure('release-spawn-error', reason, error)
      // Keep the hold so a later stop retries; the session is still live.
      return false
    }
    if (result.code !== 0 || result.timedOut) {
      // Classify here too, or the next start spends another failing Apple event
      // before noticing the engine is unusable.
      const unavailable = classifyAmphetamineFailure(result)
      if (unavailable) {
        this.failures.markUnavailable(unavailable, reason, result)
        // Only a missing app proves the session is gone. A revoked Automation
        // grant leaves it running, so keep the hold: restoring the grant is the
        // one path that can still clean it up.
        if (unavailable === 'not-installed') {
          this.hold.release()
        }
        return unavailable === 'not-installed'
      }
      this.failures.reportFailure(`release:${String(result.code)}`, reason, {
        stderr: result.stderr.trim()
      })
      return false
    }
    if (!parseReleaseOutcome(result.stdout)) {
      this.failures.reportFailure('release:unparseable', reason, { stdout: result.stdout.trim() })
      return false
    }
    // 'ended', 'foreign' and 'gone' all mean Orca no longer holds anything. The
    // script ended a session only after seeing Orca's shape — which is a check,
    // not a guarantee: without a compare-and-swap a replacement landing in
    // between is still possible. See macos-keep-awake-engines.md.
    this.hold.release()
    this.backoff.reset()
    return true
  }

  private startReconcileTimer(): void {
    this.reconcileTimer.start(this.reconcileMs, () => {
      if (this.desired === 'started' && !this.disposed) {
        this.enqueue('amphetamine-reconcile', true)
      }
    })
  }

  private stopReconcileTimer(): void {
    this.reconcileTimer.stop()
  }
}

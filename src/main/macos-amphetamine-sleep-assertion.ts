import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'
import { AmphetamineFailureBackoff } from './macos-amphetamine-failure-backoff'
import {
  AMPHETAMINE_END_SESSION_SCRIPT,
  AMPHETAMINE_PROBE_SCRIPT,
  AMPHETAMINE_START_SESSION_SCRIPT,
  classifyAmphetamineFailure,
  isOrcaShapedSession,
  NO_AMPHETAMINE_SESSION,
  parseAmphetamineSession,
  runOsascriptSyncWithRunProcess,
  runOsascriptWithRunProcess,
  type AmphetamineSessionState,
  type OsascriptResult,
  type RunOsascript,
  type RunOsascriptSync
} from './macos-amphetamine-session'

export const MACOS_AMPHETAMINE_ASSERTION_RETRY_MS = 30_000
/** A session Orca adopted can expire on its own, so re-check while we depend on it. */
export const MACOS_AMPHETAMINE_RECONCILE_MS = 30_000

type Logger = Pick<Console, 'debug' | 'warn'>

/**
 * `owned` = Orca started this session and may end it.
 * `adopted` = a session was already running, so Orca's goal is met by someone else's and Orca must not touch it.
 */
type SessionHold = 'owned' | 'adopted' | null

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
 * was running, including the user's Triggers — so this class never writes before
 * it reads. If a session already exists it is adopted, not replaced; a session
 * Orca started is only ended while it still matches the shape Orca created. The
 * user's intent always outranks Orca's.
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
  private desired: 'started' | 'stopped' = 'stopped'
  private hold: SessionHold = null
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private unavailableReason: AmphetamineUnavailableReason | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null

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
  }

  start(reason: string): void {
    if (this.platform !== 'darwin' || this.disposed || this.unavailableReason) {
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
    this.backoff.reset()
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
    if (this.hold !== 'owned') {
      this.hold = null
      return
    }
    this.hold = null
    // Why sync: quit tears the event loop down before an awaited osascript could
    // report back, and a missed `end session` leaves the Mac awake indefinitely.
    try {
      const probe = this.runOsascriptSync(AMPHETAMINE_PROBE_SCRIPT)
      const state = probe.code === 0 ? parseAmphetamineSession(probe.stdout) : null
      if (state && !isOrcaShapedSession(state)) {
        return
      }
      const result = this.runOsascriptSync(AMPHETAMINE_END_SESSION_SCRIPT)
      if (result.code !== 0) {
        this.logger.warn('[agent-awake] failed to end Amphetamine session on dispose', { result })
      }
    } catch (error) {
      this.logger.warn('[agent-awake] failed to end Amphetamine session on dispose', { error })
    }
  }

  /** True once Amphetamine proved unusable, so callers can fall back to caffeinate. */
  isUnavailable(): boolean {
    return this.unavailableReason !== null
  }

  getUnavailableReason(): AmphetamineUnavailableReason | null {
    return this.unavailableReason
  }

  /** 'owned' or 'adopted' while a session backs this assertion; null when nothing does. */
  getHold(): SessionHold {
    return this.hold
  }

  private enqueue(reason: string): void {
    this.queue = this.queue.then(() => this.reconcile(reason)).catch(() => {})
  }

  private async reconcile(reason: string): Promise<void> {
    // Bounded because `desired` can flip while an Apple event is in flight.
    for (let pass = 0; pass < 4; pass += 1) {
      if (this.disposed) {
        return
      }
      if (this.desired === 'started') {
        if (!(await this.ensureSession(reason))) {
          return
        }
      } else if (!(await this.releaseSession(reason))) {
        return
      }
      if (this.desired === (this.hold ? 'started' : 'stopped')) {
        return
      }
    }
  }

  /** Returns false when it could not make progress, so the caller stops looping. */
  private async ensureSession(reason: string): Promise<boolean> {
    if (this.unavailableReason) {
      return false
    }
    const state = await this.probeSession(reason)
    if (!state) {
      return false
    }
    if (state.presence === 'active') {
      // Someone else's session already keeps the Mac awake. Adopting is both
      // sufficient and the only way to avoid destroying their Trigger or timer.
      if (this.hold !== 'owned' || !isOrcaShapedSession(state)) {
        this.hold = 'adopted'
      }
      return true
    }
    if (this.backoff.isSuppressed()) {
      return false
    }
    let result: OsascriptResult
    try {
      result = await this.runOsascript(AMPHETAMINE_START_SESSION_SCRIPT)
    } catch (error) {
      this.handleFailure('spawn-error', reason, error)
      return false
    }
    if (result.code !== 0 || result.timedOut) {
      this.handleScriptFailure('start', reason, result)
      return false
    }
    this.hold = 'owned'
    this.backoff.reset()
    return true
  }

  private async releaseSession(reason: string): Promise<boolean> {
    if (this.hold === null) {
      return true
    }
    if (this.hold === 'adopted') {
      // Never end a session Orca did not start.
      this.hold = null
      return true
    }
    const state = await this.probeSession(reason)
    if (state && !isOrcaShapedSession(state)) {
      // Replaced while we held it; the replacement is the user's to end.
      this.hold = null
      return true
    }
    let result: OsascriptResult
    try {
      result = await this.runOsascript(AMPHETAMINE_END_SESSION_SCRIPT)
    } catch (error) {
      this.logger.warn('[agent-awake] failed to end Amphetamine session', { reason, error })
      // Keep the hold so a later stop retries; the session is still live.
      return false
    }
    if (result.code !== 0 || result.timedOut) {
      this.logger.warn('[agent-awake] failed to end Amphetamine session', { reason, result })
      // A missing app or revoked grant means there is no session left to end either.
      if (!classifyAmphetamineFailure(result)) {
        return false
      }
    }
    this.hold = null
    this.backoff.reset()
    return true
  }

  private async probeSession(reason: string): Promise<AmphetamineSessionState | null> {
    let result: OsascriptResult
    try {
      result = await this.runOsascript(AMPHETAMINE_PROBE_SCRIPT)
    } catch (error) {
      this.handleFailure('probe-spawn-error', reason, error)
      return null
    }
    if (result.code !== 0 || result.timedOut) {
      this.handleScriptFailure('probe', reason, result)
      return null
    }
    // An unparseable read must not be treated as "no session" — that would start
    // a session on top of the user's.
    return parseAmphetamineSession(result.stdout) ?? NO_AMPHETAMINE_SESSION
  }

  private startReconcileTimer(): void {
    if (this.reconcileTimer || this.reconcileMs <= 0) {
      return
    }
    this.reconcileTimer = setInterval(() => {
      if (this.desired === 'started' && !this.disposed) {
        this.enqueue('amphetamine-reconcile')
      }
    }, this.reconcileMs)
    if (typeof this.reconcileTimer.unref === 'function') {
      this.reconcileTimer.unref()
    }
  }

  private stopReconcileTimer(): void {
    if (!this.reconcileTimer) {
      return
    }
    clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
  }

  private handleScriptFailure(
    step: 'start' | 'probe',
    reason: string,
    result: OsascriptResult
  ): void {
    const unavailable = classifyAmphetamineFailure(result)
    if (unavailable) {
      this.markUnavailable(unavailable, reason, result)
      return
    }
    this.handleFailure(`${step}:${String(result.code)}`, reason, {
      code: result.code,
      stderr: result.stderr.trim(),
      timedOut: result.timedOut
    })
  }

  private markUnavailable(
    unavailableReason: AmphetamineUnavailableReason,
    reason: string,
    details: unknown
  ): void {
    if (this.unavailableReason === unavailableReason) {
      return
    }
    this.unavailableReason = unavailableReason
    this.stopReconcileTimer()
    this.backoff.reset()
    this.logger.warn('[agent-awake] Amphetamine is unavailable', {
      reason,
      unavailableReason,
      details
    })
    this.onUnavailable(unavailableReason)
  }

  private handleFailure(failureKey: string, reason: string, details: unknown): void {
    this.backoff.record(failureKey, reason, details)
    this.onUnexpectedFailure('macos-amphetamine-assertion-failure')
  }
}

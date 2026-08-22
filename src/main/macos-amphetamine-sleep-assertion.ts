import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'
import { runProcess, runProcessSync } from '../shared/child-process/run-process'

export const AMPHETAMINE_BUNDLE_ID = 'com.if.Amphetamine'
export const MACOS_AMPHETAMINE_ASSERTION_RETRY_MS = 30_000
export const MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS = 10_000

const OSASCRIPT = '/usr/bin/osascript'

/** Indefinite session: Amphetamine's own preferences decide display sleep, screen lock and lid behavior. */
const START_SESSION_SCRIPT = `tell application id "${AMPHETAMINE_BUNDLE_ID}" to start new session`
const END_SESSION_SCRIPT = `tell application id "${AMPHETAMINE_BUNDLE_ID}" to end session`
/** Launch Services lookup only — resolving a bundle id sends no Apple event, so it cannot trigger a consent prompt. */
const LOCATE_APP_SCRIPT = `POSIX path of (path to application id "${AMPHETAMINE_BUNDLE_ID}")`

export type { AmphetamineUnavailableReason }

type Logger = Pick<Console, 'debug' | 'warn'>

export type OsascriptResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type RunOsascript = (script: string) => Promise<OsascriptResult>
export type RunOsascriptSync = (script: string) => OsascriptResult

type MacosAmphetamineSleepAssertionOptions = {
  logger?: Logger
  now?: () => number
  onUnexpectedFailure?: (reason: string) => void
  onUnavailable?: (reason: AmphetamineUnavailableReason) => void
  platform?: NodeJS.Platform
  runOsascript?: RunOsascript
  runOsascriptSync?: RunOsascriptSync
}

export function runOsascriptWithRunProcess(script: string): Promise<OsascriptResult> {
  return runProcess({
    program: OSASCRIPT,
    args: ['-e', script],
    timeoutMs: MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS
  })
}

export function runOsascriptSyncWithRunProcess(script: string): OsascriptResult {
  return runProcessSync({
    program: OSASCRIPT,
    args: ['-e', script],
    timeoutMs: MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS
  })
}

/** Resolve the bundle through Launch Services; a non-zero exit means no copy is installed. */
export async function detectAmphetamineInstalled(
  runOsascriptImpl: RunOsascript = runOsascriptWithRunProcess,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (platform !== 'darwin') {
    return false
  }
  try {
    const result = await runOsascriptImpl(LOCATE_APP_SCRIPT)
    return result.code === 0 && result.stdout.trim().length > 0
  } catch {
    return false
  }
}

export function classifyAmphetamineFailure(
  result: OsascriptResult
): AmphetamineUnavailableReason | null {
  const text = `${result.stderr} ${result.stdout}`
  // -1728/-10814: Launch Services cannot resolve the bundle id, i.e. Amphetamine is not installed.
  if (text.includes('-1728') || text.includes('-10814')) {
    return 'not-installed'
  }
  // -1743/errAEEventNotPermitted: the user denied Orca's Automation grant for Amphetamine.
  if (text.includes('-1743') || text.includes('Not authorized to send Apple events')) {
    return 'automation-denied'
  }
  return null
}

/**
 * Holds a wake assertion through Amphetamine instead of `caffeinate`.
 *
 * Unlike `caffeinate`, there is no child process to own: Amphetamine keeps the
 * session, so start/stop are one-shot Apple events and the session outlives a
 * crashed Orca. Only sessions this object started are ever ended, so a session
 * the user started by hand is never cancelled.
 */
export class MacosAmphetamineSleepAssertion {
  private readonly logger: Logger
  private readonly now: () => number
  private readonly onUnexpectedFailure: (reason: string) => void
  private readonly onUnavailable: (reason: AmphetamineUnavailableReason) => void
  private readonly platform: NodeJS.Platform
  private readonly runOsascript: RunOsascript
  private readonly runOsascriptSync: RunOsascriptSync
  private desired: 'started' | 'stopped' = 'stopped'
  private sessionActive = false
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private unavailableReason: AmphetamineUnavailableReason | null = null
  private retryNotBefore: number | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private lastFailureKey: string | null = null
  private warnedForLastFailure = false

  constructor(options: MacosAmphetamineSleepAssertionOptions = {}) {
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
    this.onUnexpectedFailure = options.onUnexpectedFailure ?? (() => {})
    this.onUnavailable = options.onUnavailable ?? (() => {})
    this.platform = options.platform ?? process.platform
    this.runOsascript = options.runOsascript ?? runOsascriptWithRunProcess
    this.runOsascriptSync = options.runOsascriptSync ?? runOsascriptSyncWithRunProcess
  }

  start(reason: string): void {
    if (this.platform !== 'darwin' || this.disposed || this.unavailableReason) {
      return
    }
    this.desired = 'started'
    this.enqueue(reason)
  }

  stop(reason: string): void {
    if (this.platform !== 'darwin' || this.disposed) {
      return
    }
    this.desired = 'stopped'
    this.resetRetrySuppression()
    this.enqueue(reason)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.desired = 'stopped'
    this.resetRetrySuppression()
    if (!this.sessionActive) {
      return
    }
    // Why sync: quit tears the event loop down before an awaited osascript could
    // report back, and a missed `end session` leaves the Mac awake indefinitely.
    this.sessionActive = false
    try {
      const result = this.runOsascriptSync(END_SESSION_SCRIPT)
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

  private enqueue(reason: string): void {
    this.queue = this.queue.then(() => this.reconcile(reason)).catch(() => {})
  }

  private async reconcile(reason: string): Promise<void> {
    // Bounded because `desired` can flip while an Apple event is in flight.
    for (let pass = 0; pass < 4; pass += 1) {
      if (this.disposed) {
        return
      }
      if (this.desired === 'started' && !this.sessionActive) {
        if (!(await this.startSession(reason))) {
          return
        }
        continue
      }
      if (this.desired === 'stopped' && this.sessionActive) {
        if (!(await this.endSession(reason))) {
          return
        }
        continue
      }
      return
    }
  }

  private async startSession(reason: string): Promise<boolean> {
    if (this.unavailableReason) {
      return false
    }
    if (this.retryNotBefore !== null && this.now() < this.retryNotBefore) {
      this.scheduleRetry()
      return false
    }
    let result: OsascriptResult
    try {
      result = await this.runOsascript(START_SESSION_SCRIPT)
    } catch (error) {
      this.handleFailure('spawn-error', reason, error)
      return false
    }
    if (result.code !== 0 || result.timedOut) {
      this.handleScriptFailure('start', reason, result)
      return false
    }
    this.sessionActive = true
    this.resetRetrySuppression()
    this.resetFailureStreak()
    return true
  }

  private async endSession(reason: string): Promise<boolean> {
    let result: OsascriptResult
    try {
      result = await this.runOsascript(END_SESSION_SCRIPT)
    } catch (error) {
      this.logger.warn('[agent-awake] failed to end Amphetamine session', { reason, error })
      // Keep `sessionActive` so a later stop retries; the session is still live.
      return false
    }
    if (result.code !== 0 || result.timedOut) {
      this.logger.warn('[agent-awake] failed to end Amphetamine session', { reason, result })
      // A missing app or revoked grant means there is no session left to end either.
      if (classifyAmphetamineFailure(result)) {
        this.sessionActive = false
        return true
      }
      return false
    }
    this.sessionActive = false
    this.resetFailureStreak()
    return true
  }

  private handleScriptFailure(
    step: 'start' | 'end',
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
    this.resetRetrySuppression()
    this.logger.warn('[agent-awake] Amphetamine is unavailable', {
      reason,
      unavailableReason,
      details
    })
    this.onUnavailable(unavailableReason)
  }

  private handleFailure(failureKey: string, reason: string, details: unknown): void {
    this.logFailure(failureKey, reason, details)
    this.retryNotBefore = this.now() + MACOS_AMPHETAMINE_ASSERTION_RETRY_MS
    this.scheduleRetry()
    this.onUnexpectedFailure('macos-amphetamine-assertion-failure')
  }

  private logFailure(failureKey: string, reason: string, details: unknown): void {
    const payload = { reason, details }
    if (this.lastFailureKey === failureKey && this.warnedForLastFailure) {
      this.logger.debug('[agent-awake] Amphetamine session command failed repeatedly', payload)
      return
    }
    this.lastFailureKey = failureKey
    this.warnedForLastFailure = true
    this.logger.warn('[agent-awake] Amphetamine session command failed', payload)
  }

  private scheduleRetry(): void {
    if (this.retryNotBefore === null || this.retryTimer) {
      return
    }
    const retryDelay = Math.max(0, this.retryNotBefore - this.now())
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.onUnexpectedFailure('macos-amphetamine-assertion-retry')
    }, retryDelay)
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref()
    }
  }

  private resetRetrySuppression(): void {
    this.retryNotBefore = null
    if (!this.retryTimer) {
      return
    }
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private resetFailureStreak(): void {
    this.lastFailureKey = null
    this.warnedForLastFailure = false
  }
}

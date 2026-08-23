import {
  DEFAULT_MACOS_AWAKE_ENGINE,
  normalizeMacosAwakeEngine,
  type AmphetamineUnavailableReason,
  type MacosAwakeEngine
} from '../shared/computer-awake-mode'
import { detectAmphetamineInstalled } from './macos-amphetamine-session'
import { MacosAmphetamineSleepAssertion } from './macos-amphetamine-sleep-assertion'
import { MacosSystemSleepAssertion } from './macos-system-sleep-assertion'

type Logger = Pick<Console, 'debug' | 'warn'>

export type PlatformAwakeAssertion = {
  start: (reason: string) => void
  stop: (reason: string) => void
  dispose: () => void
}

export type AmphetamineAwakeAssertion = PlatformAwakeAssertion & {
  isUnavailable: () => boolean
  getUnavailableReason: () => AmphetamineUnavailableReason | null
  clearUnavailable: () => void
  getHold: () => 'owned' | 'adopted' | null
  hasLiveHold: () => boolean
}

export type MacosAwakeEngineStatusFields = {
  macosEngine?: MacosAwakeEngine
  amphetamineInstalled?: boolean
  amphetamineUnavailableReason?: AmphetamineUnavailableReason
}

export type MacosAwakeEngineRouterOptions = {
  amphetamineAssertion?: AmphetamineAwakeAssertion
  caffeinateAssertion?: PlatformAwakeAssertion
  detectAmphetamine?: () => Promise<boolean | undefined>
  logger?: Logger
  now?: () => number
  /** Re-run the awake decision: the live engine has to change hands immediately. */
  onNeedsRefresh?: (reason: string) => void
  platform?: NodeJS.Platform
}

/**
 * Runs the macOS wake assertions.
 *
 * Caffeinate is unconditional whenever Orca wants the Mac awake; Amphetamine is
 * additive on top of it when selected. Deliberately not a handover — see start()
 * for why one cannot be made safe. Neither engine is guaranteed to start: a
 * failure is logged, and the Electron power-save blocker held elsewhere for the
 * whole session is what remains.
 */
export class MacosAwakeEngineRouter {
  private readonly amphetamineAssertion: AmphetamineAwakeAssertion
  private readonly caffeinateAssertion: PlatformAwakeAssertion
  private readonly detectAmphetamine: () => Promise<boolean | undefined>
  private readonly logger: Logger
  private readonly onNeedsRefresh: (reason: string) => void
  private readonly platform: NodeJS.Platform
  private engine: MacosAwakeEngine = DEFAULT_MACOS_AWAKE_ENGINE
  private amphetamineInstalled: boolean | undefined
  private probing = false
  private probeAgain = false

  constructor(options: MacosAwakeEngineRouterOptions = {}) {
    this.logger = options.logger ?? console
    this.onNeedsRefresh = options.onNeedsRefresh ?? (() => {})
    this.platform = options.platform ?? process.platform
    this.detectAmphetamine = options.detectAmphetamine ?? (() => detectAmphetamineInstalled())
    const now = options.now ?? Date.now
    this.caffeinateAssertion =
      options.caffeinateAssertion ??
      new MacosSystemSleepAssertion({
        logger: this.logger,
        now,
        onUnexpectedFailure: (reason) => this.onNeedsRefresh(reason)
      })
    this.amphetamineAssertion =
      options.amphetamineAssertion ??
      new MacosAmphetamineSleepAssertion({
        logger: this.logger,
        now,
        onUnexpectedFailure: (reason) => this.onNeedsRefresh(reason),
        // Why refresh rather than just record: caffeinate has to take over the
        // live session, otherwise choosing Amphetamine silently stops holding it.
        onHoldChanged: () => this.onNeedsRefresh('amphetamine-held'),
        onUnavailable: (unavailableReason) => {
          if (unavailableReason === 'not-installed') {
            this.amphetamineInstalled = false
          }
          this.onNeedsRefresh('amphetamine-unavailable')
        }
      })
  }

  /** Returns true when the caller should refresh. */
  setEngine(engine: MacosAwakeEngine): boolean {
    const normalized = normalizeMacosAwakeEngine(engine)
    if (normalized === 'amphetamine') {
      // Re-picking Amphetamine is the user's retry gesture after fixing a
      // refused Automation grant, so it must clear the verdict even when the
      // engine is unchanged.
      this.amphetamineAssertion.clearUnavailable()
      void this.probeInstalled()
    }
    if (this.engine === normalized) {
      return normalized === 'amphetamine'
    }
    this.engine = normalized
    // The outgoing engine is released by start(), only once the incoming one
    // actually holds — see the note there.
    return true
  }

  /** Probe once, lazily, the first time anything asks for status. */
  async probeInstalledIfUnknown(): Promise<boolean | undefined> {
    if (this.amphetamineInstalled !== undefined) {
      return this.amphetamineInstalled
    }
    return this.probeInstalled()
  }

  /** Refresh the installed probe so the picker can disable Amphetamine before it is ever selected. */
  async probeInstalled(): Promise<boolean | undefined> {
    if (this.platform !== 'darwin') {
      return undefined
    }
    if (this.probing) {
      // Concurrent probes can resolve out of order and clobber each other, but
      // dropping the request would strand a re-pick made just after an older
      // probe sampled absence. Queue exactly one follow-up instead.
      this.probeAgain = true
      return this.amphetamineInstalled
    }
    this.probing = true
    try {
      let installed = await this.runInstalledProbe()
      while (this.probeAgain) {
        this.probeAgain = false
        installed = await this.runInstalledProbe()
      }
      return installed
    } finally {
      this.probing = false
      this.probeAgain = false
    }
  }

  private async runInstalledProbe(): Promise<boolean | undefined> {
    try {
      const installed = await this.detectAmphetamine()
      if (installed === undefined || this.amphetamineInstalled === installed) {
        // undefined means the probe could not tell; keep whatever is known
        // rather than recording a false negative that disables the engine.
        return this.amphetamineInstalled
      }
      this.amphetamineInstalled = installed
      this.onNeedsRefresh('amphetamine-probe')
      return installed
    } catch (err) {
      this.logger.warn('[agent-awake] failed to probe for Amphetamine', { error: err })
      return this.amphetamineInstalled
    }
  }

  start(reason: string): void {
    // Caffeinate always runs. There is no handover, because a handover cannot be
    // made safe: any liveness answer about caffeinate is stale the instant it is
    // read — the spawn can fail asynchronously and the child can exit at any
    // moment — so releasing the other engine on it is always a gamble. Three
    // separate review rounds each found a different sequence ending with nothing
    // held, and each fix produced another. Holding both costs one small child
    // process; holding neither is the bug this exists to prevent.
    this.startAssertion(this.caffeinateAssertion, 'macOS system sleep', reason)
    if (this.usesAmphetamine()) {
      this.startAssertion(this.amphetamineAssertion, 'Amphetamine', reason)
    } else {
      this.stopAssertion(this.amphetamineAssertion, 'Amphetamine', reason)
    }
  }

  private startAssertion(assertion: PlatformAwakeAssertion, label: string, reason: string): void {
    try {
      assertion.start(reason)
    } catch (err) {
      this.logger.warn(`[agent-awake] failed to start ${label} assertion`, { reason, error: err })
    }
  }

  stop(reason: string): void {
    this.stopAssertion(this.caffeinateAssertion, 'macOS system sleep', reason)
    this.stopAssertion(this.amphetamineAssertion, 'Amphetamine', reason)
  }

  dispose(): void {
    // Isolated: a throwing caffeinate dispose must not skip Amphetamine's, which
    // is the one that can outlive the process.
    this.disposeAssertion(this.caffeinateAssertion, 'macOS system sleep')
    this.disposeAssertion(this.amphetamineAssertion, 'Amphetamine')
  }

  private disposeAssertion(assertion: PlatformAwakeAssertion, label: string): void {
    try {
      assertion.dispose()
    } catch (err) {
      this.logger.warn(`[agent-awake] failed to dispose ${label} assertion`, { error: err })
    }
  }

  statusFields(): MacosAwakeEngineStatusFields {
    if (this.platform !== 'darwin') {
      return {}
    }
    const unavailableReason = this.amphetamineAssertion.getUnavailableReason()
    return {
      macosEngine: this.engine,
      ...(this.amphetamineInstalled === undefined
        ? {}
        : { amphetamineInstalled: this.amphetamineInstalled }),
      ...(unavailableReason ? { amphetamineUnavailableReason: unavailableReason } : {})
    }
  }

  /** Amphetamine only when it is both chosen and proven usable; caffeinate is the always-available fallback. */
  private usesAmphetamine(): boolean {
    return (
      // The engine setting is writable on every platform, so gate on the host too.
      this.platform === 'darwin' &&
      this.engine === 'amphetamine' &&
      // A known-missing app would otherwise cost a failed Apple event per refresh.
      this.amphetamineInstalled !== false &&
      !this.amphetamineAssertion.isUnavailable()
    )
  }

  private stopAssertion(assertion: PlatformAwakeAssertion, label: string, reason: string): void {
    try {
      assertion.stop(reason)
    } catch (err) {
      this.logger.warn(`[agent-awake] failed to stop ${label} assertion`, { reason, error: err })
    }
  }
}

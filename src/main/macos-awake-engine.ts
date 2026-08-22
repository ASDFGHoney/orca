import {
  DEFAULT_MACOS_AWAKE_ENGINE,
  normalizeMacosAwakeEngine,
  type AmphetamineUnavailableReason,
  type MacosAwakeEngine
} from '../shared/computer-awake-mode'
import {
  detectAmphetamineInstalled,
  MacosAmphetamineSleepAssertion
} from './macos-amphetamine-sleep-assertion'
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
}

export type MacosAwakeEngineStatusFields = {
  macosEngine?: MacosAwakeEngine
  amphetamineInstalled?: boolean
  amphetamineUnavailableReason?: AmphetamineUnavailableReason
}

export type MacosAwakeEngineRouterOptions = {
  amphetamineAssertion?: AmphetamineAwakeAssertion
  caffeinateAssertion?: PlatformAwakeAssertion
  detectAmphetamine?: () => Promise<boolean>
  logger?: Logger
  now?: () => number
  /** Re-run the awake decision: the live engine has to change hands immediately. */
  onNeedsRefresh?: (reason: string) => void
  platform?: NodeJS.Platform
}

/**
 * Picks which macOS tool holds the wake assertion and guarantees only one holds
 * it at a time. Caffeinate is always available; Amphetamine is opt-in, can be
 * missing or refused, and falls back to caffeinate when it is.
 */
export class MacosAwakeEngineRouter {
  private readonly amphetamineAssertion: AmphetamineAwakeAssertion
  private readonly caffeinateAssertion: PlatformAwakeAssertion
  private readonly detectAmphetamine: () => Promise<boolean>
  private readonly logger: Logger
  private readonly onNeedsRefresh: (reason: string) => void
  private readonly platform: NodeJS.Platform
  private engine: MacosAwakeEngine = DEFAULT_MACOS_AWAKE_ENGINE
  private amphetamineInstalled: boolean | undefined

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
        onUnavailable: (unavailableReason) => {
          if (unavailableReason === 'not-installed') {
            this.amphetamineInstalled = false
          }
          this.onNeedsRefresh('amphetamine-unavailable')
        }
      })
  }

  /** Returns true when the choice actually changed, so the caller knows to refresh. */
  setEngine(engine: MacosAwakeEngine): boolean {
    const normalized = normalizeMacosAwakeEngine(engine)
    if (this.engine === normalized) {
      return false
    }
    // Release the outgoing engine first so the two never hold a session at once.
    this.stop('macos-engine-change')
    this.engine = normalized
    if (normalized === 'amphetamine') {
      void this.probeInstalled()
    }
    return true
  }

  /** Refresh the installed probe so the picker can disable Amphetamine before it is ever selected. */
  async probeInstalled(): Promise<boolean | undefined> {
    if (this.platform !== 'darwin') {
      return undefined
    }
    try {
      const installed = await this.detectAmphetamine()
      if (this.amphetamineInstalled === installed) {
        return installed
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
    const useAmphetamine = this.usesAmphetamine()
    // Stop the engine we are not using before starting the one we are, so a
    // mid-session engine switch never leaves two assertions held.
    this.stopAssertion(
      useAmphetamine ? this.caffeinateAssertion : this.amphetamineAssertion,
      useAmphetamine ? 'macOS system sleep' : 'Amphetamine',
      reason
    )
    try {
      if (useAmphetamine) {
        this.amphetamineAssertion.start(reason)
      } else {
        this.caffeinateAssertion.start(reason)
      }
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start macOS sleep assertion', {
        reason,
        engine: useAmphetamine ? 'amphetamine' : 'caffeinate',
        error: err
      })
    }
  }

  stop(reason: string): void {
    this.stopAssertion(this.caffeinateAssertion, 'macOS system sleep', reason)
    this.stopAssertion(this.amphetamineAssertion, 'Amphetamine', reason)
  }

  dispose(): void {
    this.caffeinateAssertion.dispose()
    this.amphetamineAssertion.dispose()
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
    return this.engine === 'amphetamine' && !this.amphetamineAssertion.isUnavailable()
  }

  private stopAssertion(assertion: PlatformAwakeAssertion, label: string, reason: string): void {
    try {
      assertion.stop(reason)
    } catch (err) {
      this.logger.warn(`[agent-awake] failed to stop ${label} assertion`, { reason, error: err })
    }
  }
}

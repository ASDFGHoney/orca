import { powerSaveBlocker } from 'electron'

export type PowerSaveBlocker = {
  start: (type: 'prevent-app-suspension' | 'prevent-display-sleep') => number
  stop: (id: number) => void
  isStarted: (id: number) => boolean
}

type Logger = Pick<Console, 'debug' | 'warn'>

/** Extra fields the caller wants on every warning, so log payloads stay diagnosable. */
export type BlockerLogContext = Record<string, unknown>

/**
 * Owns the Electron power-save blocker id.
 *
 * Electron can drop a blocker without telling us (id reuse across suspends), so
 * every transition re-reads `isStarted` rather than trusting the stored id.
 */
export class AgentAwakePowerSaveBlocker {
  private readonly blocker: PowerSaveBlocker
  private readonly logger: Logger
  private blockerId: number | null = null

  constructor(blocker: PowerSaveBlocker = powerSaveBlocker, logger: Logger = console) {
    this.blocker = blocker
    this.logger = logger
  }

  start(reason: string, context: BlockerLogContext = {}): void {
    if (this.blockerId !== null && this.reconcile('start-reconcile')) {
      return
    }
    try {
      this.blockerId = this.blocker.start('prevent-display-sleep')
      this.reconcile('post-start')
    } catch (err) {
      this.logger.warn('[agent-awake] failed to start blocker', { reason, ...context, error: err })
    }
  }

  stop(reason: string, context: BlockerLogContext = {}): void {
    if (this.blockerId === null) {
      return
    }
    const id = this.blockerId
    try {
      this.blocker.stop(id)
    } catch (err) {
      this.logger.warn('[agent-awake] failed to stop blocker', {
        reason,
        ...context,
        blockerId: id,
        error: err
      })
    }
    this.reconcile('post-stop')
  }

  private reconcile(reason: string): boolean {
    if (this.blockerId === null) {
      return false
    }
    const id = this.blockerId
    try {
      const isStarted = this.blocker.isStarted(id)
      if (!isStarted) {
        this.blockerId = null
      }
      return isStarted
    } catch (err) {
      this.logger.warn('[agent-awake] failed to reconcile blocker', {
        reason,
        blockerId: id,
        error: err
      })
      return true
    }
  }
}

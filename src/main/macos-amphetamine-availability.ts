import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'

/**
 * Whether Amphetamine is usable, and why not.
 *
 * Kept apart from the assertion because the verdict is sticky and recoverable in
 * its own right: the assertion decides what a failure means for the session it
 * holds, this decides whether the engine may be attempted at all.
 */
export class AmphetamineAvailability {
  private reason: AmphetamineUnavailableReason | null = null

  /** Returns true only on a change, so callers report each verdict once. */
  mark(reason: AmphetamineUnavailableReason): boolean {
    if (this.reason === reason) {
      return false
    }
    this.reason = reason
    return true
  }

  /** Returns true only if a verdict was actually forgotten. */
  clear(): boolean {
    if (!this.reason) {
      return false
    }
    this.reason = null
    return true
  }

  get(): AmphetamineUnavailableReason | null {
    return this.reason
  }

  isUnavailable(): boolean {
    return this.reason !== null
  }
}

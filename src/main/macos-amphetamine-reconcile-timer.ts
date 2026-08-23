/**
 * Periodic re-check while Orca depends on an Amphetamine session it did not start.
 *
 * An adopted session can be a timer that expires, and a session Orca owns can be
 * replaced, so depending on one means re-reading it on an interval. Unref'd: this
 * must never be the reason the process stays alive.
 */
export class AmphetamineReconcileTimer {
  private handle: ReturnType<typeof setInterval> | null = null

  /** No-op when already running, or when the interval is non-positive (tests). */
  start(intervalMs: number, onTick: () => void): void {
    if (this.handle || intervalMs <= 0) {
      return
    }
    this.handle = setInterval(onTick, intervalMs)
    if (typeof this.handle.unref === 'function') {
      this.handle.unref()
    }
  }

  stop(): void {
    if (!this.handle) {
      return
    }
    clearInterval(this.handle)
    this.handle = null
  }
}

/**
 * What Orca believes about the Amphetamine session backing its assertion.
 *
 * Two questions that look like one and are not, which is why they live together
 * here: *is there something to clean up* (the classification, which survives a
 * failed attempt) and *is anything actually holding right now* (liveness, which
 * does not). Conflating them once let the router drop its caffeinate stand-in on
 * the strength of a hold that had just failed.
 */
export type AmphetamineHoldKind = 'owned' | 'adopted' | null

export class AmphetamineHold {
  private kind: AmphetamineHoldKind = null
  private stale = false

  /** Orca started this session, or reclaimed one it had left behind. */
  own(): void {
    this.kind = 'owned'
    this.stale = false
  }

  /** Someone else's session is doing the job; Orca must not end it. */
  adopt(): void {
    this.kind = 'adopted'
    this.stale = false
  }

  release(): void {
    this.kind = null
    this.stale = false
  }

  /** An attempt failed: keep the classification, stop vouching for it. */
  markStale(): void {
    this.stale = true
  }

  get(): AmphetamineHoldKind {
    return this.kind
  }

  isOwned(): boolean {
    return this.kind === 'owned'
  }

  /** True only when a session is believed to be holding right now. */
  isLive(): boolean {
    return this.kind !== null && !this.stale
  }
}

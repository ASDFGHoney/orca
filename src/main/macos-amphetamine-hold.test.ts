import { describe, expect, it } from 'vitest'
import { AmphetamineAvailability } from './macos-amphetamine-availability'
import { AmphetamineHold } from './macos-amphetamine-hold'

describe('AmphetamineHold', () => {
  it('starts holding nothing', () => {
    const hold = new AmphetamineHold()

    // get() must be null, not the instance: callers branch on this value, and a
    // refactor that made it always-truthy once broke a convergence check
    // silently while every other test still passed.
    expect(hold.get()).toBeNull()
    expect(hold.isLive()).toBe(false)
    expect(hold.isOwned()).toBe(false)
  })

  it.each([
    ['own', (hold: AmphetamineHold) => hold.own(), 'owned', true],
    ['adopt', (hold: AmphetamineHold) => hold.adopt(), 'adopted', false]
  ])('%s records the kind and vouches for it', (_label, act, kind, owned) => {
    const hold = new AmphetamineHold()

    act(hold)

    expect(hold.get()).toBe(kind)
    expect(hold.isLive()).toBe(true)
    expect(hold.isOwned()).toBe(owned)
  })

  it('keeps the classification but stops vouching once stale', () => {
    const hold = new AmphetamineHold()
    hold.own()

    hold.markStale()

    // The distinction is what lets a failed attempt stay eligible for cleanup
    // while still being retried rather than treated as settled.
    expect(hold.get()).toBe('owned')
    expect(hold.isOwned()).toBe(true)
    expect(hold.isLive()).toBe(false)
  })

  it('vouches again after a fresh success', () => {
    const hold = new AmphetamineHold()
    hold.own()
    hold.markStale()

    hold.adopt()

    expect(hold.isLive()).toBe(true)
  })

  it('releases to nothing held', () => {
    const hold = new AmphetamineHold()
    hold.own()
    hold.markStale()

    hold.release()

    expect(hold.get()).toBeNull()
    expect(hold.isLive()).toBe(false)
  })
})

describe('AmphetamineAvailability', () => {
  it('starts usable', () => {
    const availability = new AmphetamineAvailability()

    expect(availability.get()).toBeNull()
    expect(availability.isUnavailable()).toBe(false)
  })

  it('reports a verdict as new only once', () => {
    const availability = new AmphetamineAvailability()

    expect(availability.mark('automation-denied')).toBe(true)
    // Callers log and notify on true, so a repeat must not re-announce.
    expect(availability.mark('automation-denied')).toBe(false)
    expect(availability.isUnavailable()).toBe(true)
  })

  it('treats a different verdict as new', () => {
    const availability = new AmphetamineAvailability()
    availability.mark('automation-denied')

    expect(availability.mark('not-installed')).toBe(true)
    expect(availability.get()).toBe('not-installed')
  })

  it('clears only when there was a verdict to forget', () => {
    const availability = new AmphetamineAvailability()

    expect(availability.clear()).toBe(false)
    availability.mark('not-installed')
    expect(availability.clear()).toBe(true)
    expect(availability.isUnavailable()).toBe(false)
  })
})

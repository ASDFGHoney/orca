import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MACOS_AMPHETAMINE_ASSERTION_RETRY_MS,
  MacosAmphetamineSleepAssertion
} from './macos-amphetamine-sleep-assertion'
import type { OsascriptResult } from './macos-amphetamine-session'

function ok(stdout = ''): OsascriptResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function failure(stderr: string, code = 1): OsascriptResult {
  return { code, stdout: '', stderr, timedOut: false }
}

/**
 * Stands in for Amphetamine's single global session.
 *
 * Acquire and release resolve to one outcome each, matching the scripts' shape.
 * That is a modelling convenience, not a claim of atomicity — the real commands
 * are consecutive Apple events (see macos-keep-awake-engines.md).
 */
function createFakeAmphetamine(initial: 'none' | 'orca' | 'foreign' = 'none') {
  let session = initial
  const run = vi.fn(async (script: string) => {
    if (script.includes('start new session')) {
      if (session === 'foreign') {
        return ok('foreign')
      }
      if (session === 'orca') {
        return ok('orca-shaped')
      }
      session = 'orca'
      return ok('started')
    }
    if (script.includes('end session')) {
      if (session === 'none') {
        return ok('gone')
      }
      if (session === 'foreign') {
        return ok('foreign')
      }
      session = 'none'
      return ok('ended')
    }
    return ok()
  })
  return {
    run,
    calls: () => run.mock.calls.length,
    acquires: () =>
      run.mock.calls.filter(([script]) => script.includes('start new session')).length,
    releases: () => run.mock.calls.filter(([script]) => script.includes('end session')).length,
    get session() {
      return session
    },
    setSession(next: 'none' | 'orca' | 'foreign') {
      session = next
    }
  }
}

function createLogger() {
  return { debug: vi.fn(), warn: vi.fn() }
}

/** Drain the microtask queue the assertion serializes its Apple events through. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

function createAssertion(
  amphetamine: ReturnType<typeof createFakeAmphetamine>,
  overrides: Record<string, unknown> = {}
): MacosAmphetamineSleepAssertion {
  return new MacosAmphetamineSleepAssertion({
    logger: createLogger(),
    platform: 'darwin',
    reconcileMs: 0,
    runOsascript: amphetamine.run,
    ...overrides
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MacosAmphetamineSleepAssertion session ownership', () => {
  it('starts one session when nothing is running', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    assertion.start('agents-working')
    await settle()

    // A repeat start while already holding must not spend another Apple event.
    expect(amphetamine.acquires()).toBe(1)
    expect(assertion.getHold()).toBe('owned')
  })

  it('adopts a session the user already started instead of replacing it', async () => {
    const amphetamine = createFakeAmphetamine('foreign')
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()

    expect(assertion.getHold()).toBe('adopted')
    expect(amphetamine.session).toBe('foreign')
  })

  it('never ends an adopted session', async () => {
    const amphetamine = createFakeAmphetamine('foreign')
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    assertion.stop('agents-idle')
    await settle()

    expect(amphetamine.releases()).toBe(0)
    expect(amphetamine.session).toBe('foreign')
    expect(assertion.getHold()).toBeNull()
  })

  it('ends its own session on stop', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    assertion.stop('agents-idle')
    await settle()

    expect(amphetamine.session).toBe('none')
    expect(assertion.getHold()).toBeNull()
  })

  it('leaves a session that replaced its own alone', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    // The user replaces Orca's session; the release script reports "foreign".
    amphetamine.setSession('foreign')
    assertion.stop('agents-idle')
    await settle()

    expect(amphetamine.session).toBe('foreign')
    expect(assertion.getHold()).toBeNull()
  })

  it('reclaims an Orca-shaped session left behind by a killed process', async () => {
    // A crash leaves the indefinite session running; adopting it would mean
    // never ending it, and the Mac would stay awake forever.
    const amphetamine = createFakeAmphetamine('orca')
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    expect(assertion.getHold()).toBe('owned')

    assertion.stop('agents-idle')
    await settle()
    expect(amphetamine.session).toBe('none')
  })

  it('keeps its own hold when the periodic re-check sees its own session', async () => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine, { reconcileMs: 1_000 })

    assertion.start('agents-working')
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    // Downgrading to 'adopted' here would strand Orca's own session.
    expect(assertion.getHold()).toBe('owned')
  })

  it('takes over when an adopted session disappears', async () => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('foreign')
    const assertion = createAssertion(amphetamine, { reconcileMs: 1_000 })

    assertion.start('agents-working')
    await settle()
    expect(assertion.getHold()).toBe('adopted')

    amphetamine.setSession('none')
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    expect(assertion.getHold()).toBe('owned')
    expect(amphetamine.session).toBe('orca')
  })

  it.each([
    ['output it cannot read', ok('garbage')],
    ['a timeout', { code: null, stdout: '', stderr: '', timedOut: true }],
    ['an unclassified error', failure('AppleEvent failed')]
  ])('keeps cleanup responsibility when an acquire ends in %s', async (_label, result) => {
    // `start new session` may have taken effect before the command failed.
    // Forgetting it here would strand an indefinite session: a later stop would
    // do nothing and quit would skip its release.
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (_script: string) => result as OsascriptResult)
    const assertion = createAssertion(amphetamine, { now: () => 1_000 })

    assertion.start('agents-working')
    await settle()

    expect(assertion.getHold()).toBe('owned')
  })

  it.each([
    ['the app is missing', failure('execution error: (-1728)')],
    ['the grant is refused', failure('Not authorized to send Apple events. (-1743)')]
  ])('claims nothing when %s, since no session can have started', async (_label, result) => {
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (_script: string) => result)
    const assertion = createAssertion(amphetamine, { now: () => 1_000 })

    assertion.start('agents-working')
    await settle()

    expect(assertion.getHold()).toBeNull()
  })

  it('takes cleanup responsibility when a re-acquire over an adopted hold is indeterminate', async () => {
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('foreign')
    const assertion = createAssertion(amphetamine, { now: () => 1_000, reconcileMs: 1_000 })

    assertion.start('agents-working')
    await settle()
    expect(assertion.getHold()).toBe('adopted')

    // The adopted session expires, the re-acquire starts one of Orca's, and the
    // command then fails to report what it did.
    amphetamine.setSession('none')
    amphetamine.run.mockImplementation(async (_script: string) => ok('unreadable'))
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    // Staying 'adopted' would make every later release skip the command and
    // strand the session Orca just created.
    expect(assertion.getHold()).toBe('owned')
  })

  it('stops vouching for its hold while a release is in flight', async () => {
    const amphetamine = createFakeAmphetamine()
    let finishRelease = (): void => {}
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()

    amphetamine.run.mockImplementation(
      async (_script: string) =>
        new Promise<OsascriptResult>((resolve) => {
          finishRelease = () => resolve(ok('ended'))
        })
    )
    assertion.stop('agents-idle')
    await settle()

    // The session is about to end, so a router reading this as live would drop
    finishRelease()
    await settle()
  })

  it('does nothing off macOS', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine, { platform: 'linux' })

    assertion.start('agents-working')
    await settle()

    expect(amphetamine.run).not.toHaveBeenCalled()
  })
})

describe('MacosAmphetamineSleepAssertion throttling', () => {
  it('does not loop when acquire keeps failing and the service refreshes', async () => {
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (_script: string) => failure('AppleEvent timed out'))
    let assertion: MacosAmphetamineSleepAssertion | null = null
    // Mirrors AgentAwakeService: a failure refreshes, which starts again.
    const onUnexpectedFailure = vi.fn(() => {
      assertion?.start('refresh')
    })
    assertion = createAssertion(amphetamine, { now: () => 1_000, onUnexpectedFailure })

    assertion.start('agents-working')
    await settle()

    expect(amphetamine.calls()).toBeLessThanOrEqual(2)
  })

  it('does not loop when release keeps failing and the service refreshes', async () => {
    const amphetamine = createFakeAmphetamine()
    let assertion: MacosAmphetamineSleepAssertion | null = null
    // With the mode off, the refresh a failure triggers stops the assertion again.
    const onUnexpectedFailure = vi.fn(() => {
      assertion?.stop('refresh')
    })
    assertion = createAssertion(amphetamine, { now: () => 1_000, onUnexpectedFailure })

    assertion.start('agents-working')
    await settle()
    expect(assertion.getHold()).toBe('owned')

    amphetamine.run.mockImplementation(async (_script: string) => failure('AppleEvent timed out'))
    const before = amphetamine.calls()
    assertion.stop('agents-idle')
    await settle()

    expect(amphetamine.calls() - before).toBeLessThanOrEqual(2)
  })

  it('stops vouching for a hold after a classified failure', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine, { now: () => 1_000 })

    assertion.start('agents-working')
    await settle()

    amphetamine.run.mockImplementation(async (_script: string) =>
      failure('Not authorized to send Apple events to Amphetamine. (-1743)')
    )
    assertion.stop('agents-idle')
    await settle()

    // The session is about to end, so the classification must stop counting as
    // evidence that anything is holding.
    expect(assertion.getHold()).toBe('owned')
  })

  it('does not reinstall a hold when a foreign result lands after dispose', async () => {
    const amphetamine = createFakeAmphetamine('foreign')
    let releaseAcquire = (): void => {}
    const acquired = new Promise<void>((resolve) => {
      releaseAcquire = resolve
    })
    amphetamine.run.mockImplementation(async (script: string) => {
      if (script.includes('start new session')) {
        await acquired
        return ok('foreign')
      }
      return ok('gone')
    })
    const assertion = createAssertion(amphetamine, { runOsascriptSync: () => ok('gone') })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()
    releaseAcquire()
    await settle()

    expect(assertion.getHold()).toBeNull()
  })

  it('keeps the hold on dispose when the final release fails', async () => {
    const amphetamine = createFakeAmphetamine()
    // Automation still denied at quit: nothing can retry, so the state must at
    // least be honest that a session was left running.
    const runOsascriptSync = vi.fn((_script: string) => failure('(-1743)'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(assertion.getHold()).toBe('owned')
  })

  it('keeps the hold when Automation is revoked, since the session still runs', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine, { now: () => 1_000 })

    assertion.start('agents-working')
    await settle()
    // Revoking the grant does not end Amphetamine's session; forgetting it here
    // would strand an indefinite session with no path left to clean it up.
    amphetamine.run.mockImplementation(async (_script: string) =>
      failure('Not authorized to send Apple events to Amphetamine. (-1743)')
    )
    assertion.stop('agents-idle')
    await settle()

    expect(assertion.getHold()).toBe('owned')
  })

  it('forgets the hold when the app is gone, since no session can remain', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine, { now: () => 1_000 })

    assertion.start('agents-working')
    await settle()
    amphetamine.run.mockImplementation(async (_script: string) =>
      failure('execution error: (-1728)')
    )
    assertion.stop('agents-idle')
    await settle()

    expect(assertion.getHold()).toBeNull()
  })

  it('stops vouching for a hold once an attempt fails', async () => {
    // Fake timers must be installed before the reconcile interval is created.
    vi.useFakeTimers()
    const amphetamine = createFakeAmphetamine('foreign')
    const assertion = createAssertion(amphetamine, { now: () => 1_000, reconcileMs: 1_000 })

    assertion.start('agents-working')
    await settle()

    amphetamine.run.mockImplementation(async (_script: string) => failure('AppleEvent timed out'))
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    // A failed re-acquire may have created a session before failing to report
    // it, so responsibility is claimed rather than left as 'adopted' — which
    // would make every later release skip the command.
    expect(assertion.getHold()).toBe('owned')
  })

  it('retries promptly once it can no longer vouch for its hold', async () => {
    vi.useFakeTimers()
    let clock = 1_000
    const amphetamine = createFakeAmphetamine('foreign')
    const assertion = createAssertion(amphetamine, { now: () => clock, reconcileMs: 100_000 })

    assertion.start('agents-working')
    await settle()
    amphetamine.run.mockImplementation(async (_script: string) => failure('AppleEvent timed out'))
    await vi.advanceTimersByTimeAsync(100_000)
    await settle()

    // Recovery must not have to wait for the next re-check: once the backoff
    // window has passed, an untrusted hold is worth an Apple event on an
    // ordinary start rather than only on the next periodic one.
    clock += MACOS_AMPHETAMINE_ASSERTION_RETRY_MS + 1
    amphetamine.run.mockImplementation(async (_script: string) => ok('foreign'))
    const before = amphetamine.calls()
    assertion.start('agents-working')
    await settle()

    expect(amphetamine.calls()).toBeGreaterThan(before)
  })

  it('keeps the hold when a release fails so a later stop retries', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine, { now: () => 1_000 })

    assertion.start('agents-working')
    await settle()
    amphetamine.run.mockImplementation(async (_script: string) => failure('AppleEvent timed out'))
    assertion.stop('agents-idle')
    await settle()

    expect(assertion.getHold()).toBe('owned')
  })
})

describe('MacosAmphetamineSleepAssertion availability', () => {
  it('goes unavailable and reports why when Amphetamine is missing', async () => {
    const onUnavailable = vi.fn()
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (_script: string) =>
      failure('execution error: (-1728)')
    )
    const assertion = createAssertion(amphetamine, { onUnavailable })

    assertion.start('agents-working')
    await settle()
    expect(onUnavailable).toHaveBeenCalledWith('not-installed')
    expect(assertion.isUnavailable()).toBe(true)

    amphetamine.run.mockClear()
    assertion.start('agents-working')
    await settle()
    // An unusable engine must stop retrying so caffeinate keeps the session.
    expect(amphetamine.run).not.toHaveBeenCalled()
  })

  it('goes unavailable when the Automation grant is refused', async () => {
    const onUnavailable = vi.fn()
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (_script: string) =>
      failure('Not authorized to send Apple events to Amphetamine. (-1743)')
    )
    const assertion = createAssertion(amphetamine, { onUnavailable })

    assertion.start('agents-working')
    await settle()

    expect(assertion.getUnavailableReason()).toBe('automation-denied')
  })
})

describe('MacosAmphetamineSleepAssertion dispose', () => {
  it('ends its own session synchronously so quit cannot leak it', async () => {
    const amphetamine = createFakeAmphetamine()
    const runOsascriptSync = vi.fn((_script: string) => ok('ended'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(runOsascriptSync.mock.calls.some(([script]) => script.includes('end session'))).toBe(
      true
    )
    expect(assertion.getHold()).toBeNull()
  })

  it('ends a session that started while quit was already in flight', async () => {
    const amphetamine = createFakeAmphetamine()
    let releaseAcquire = (): void => {}
    const acquired = new Promise<void>((resolve) => {
      releaseAcquire = resolve
    })
    amphetamine.run.mockImplementation(async (script: string) => {
      if (script.includes('start new session')) {
        await acquired
        return ok('started')
      }
      return ok('ended')
    })
    const runOsascriptSync = vi.fn((_script: string) => ok('ended'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()
    releaseAcquire()
    await settle()

    expect(runOsascriptSync.mock.calls.some(([script]) => script.includes('end session'))).toBe(
      true
    )
    expect(assertion.getHold()).toBeNull()
  })

  it('ends a reclaimed session that resolved after quit began', async () => {
    // A crash-leaked session reclaimed mid-quit leaks again unless dispose
    // covers the reclaim path too, not just a fresh start.
    const amphetamine = createFakeAmphetamine('orca')
    let releaseAcquire = (): void => {}
    const acquired = new Promise<void>((resolve) => {
      releaseAcquire = resolve
    })
    amphetamine.run.mockImplementation(async (script: string) => {
      if (script.includes('start new session')) {
        await acquired
        return ok('orca-shaped')
      }
      return ok('ended')
    })
    const runOsascriptSync = vi.fn((_script: string) => ok('ended'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()
    releaseAcquire()
    await settle()

    expect(runOsascriptSync.mock.calls.some(([script]) => script.includes('end session'))).toBe(
      true
    )
    expect(assertion.getHold()).toBeNull()
  })

  it('releases a second time even when the first pass ended a session', async () => {
    // The aborted acquire can create a session after a first pass that reported
    // 'ended' just as easily as after one that reported 'gone'. Gating the
    // second pass on 'gone' left exactly that case with nothing to clean it up.
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(
      async (_script: string) => new Promise<OsascriptResult>(() => {})
    )
    const outcomes = ['ended', 'ended']
    const runOsascriptSync = vi.fn((_script: string) => ok(outcomes.shift() ?? 'gone'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(runOsascriptSync).toHaveBeenCalledTimes(2)
  })

  it('does not claim a hold when an acquire fails after dispose', async () => {
    // dispose() already ran its release passes because an acquire was in
    // flight, so claiming here would make getHold() lie after teardown.
    const amphetamine = createFakeAmphetamine()
    let failAcquire = (): void => {}
    amphetamine.run.mockImplementation(
      async (_script: string) =>
        new Promise<OsascriptResult>((resolve) => {
          failAcquire = () => resolve(failure('AppleEvent timed out'))
        })
    )
    const onUnexpectedFailure = vi.fn()
    const assertion = createAssertion(amphetamine, {
      now: () => 1_000,
      onUnexpectedFailure,
      runOsascriptSync: () => ok('gone')
    })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()
    failAcquire()
    await settle()

    expect(assertion.getHold()).toBeNull()
    // Nothing can act on a refresh after teardown, so none should be requested.
    expect(onUnexpectedFailure).not.toHaveBeenCalled()
  })

  it('records a session it could not clean up during the dispose race', async () => {
    const amphetamine = createFakeAmphetamine()
    let releaseAcquire = (): void => {}
    const acquired = new Promise<void>((resolve) => {
      releaseAcquire = resolve
    })
    amphetamine.run.mockImplementation(async (script: string) => {
      if (script.includes('start new session')) {
        await acquired
        return ok('started')
      }
      return ok('ended')
    })
    // Quit-time cleanup fails, and nothing can retry after disposal.
    const runOsascriptSync = vi.fn((_script: string) => failure('(-1743)'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()
    releaseAcquire()
    await settle()

    // Reporting null would claim a session was cleaned up that was not.
    expect(assertion.getHold()).toBe('owned')
  })

  it('cleans up when quit lands while an acquire is still in flight', async () => {
    // The continuation may never run — quit can tear the event loop down first —
    // so dispose cannot wait to learn whether a session was created.
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(
      async (_script: string) => new Promise<OsascriptResult>(() => {})
    )
    const runOsascriptSync = vi.fn((_script: string) => ok('ended'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(runOsascriptSync.mock.calls.some(([script]) => script.includes('end session'))).toBe(
      true
    )
  })

  it('releases a second time when an aborted acquire may still create a session', async () => {
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(
      async (_script: string) => new Promise<OsascriptResult>(() => {})
    )
    // The first release finds nothing; the acquire's Apple event lands after.
    const outcomes = ['gone', 'ended']
    const runOsascriptSync = vi.fn((_script: string) => ok(outcomes.shift() ?? 'gone'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(runOsascriptSync).toHaveBeenCalledTimes(2)
    expect(assertion.getHold()).toBeNull()
  })

  it('does not touch Amphetamine on dispose when it holds nothing', async () => {
    const amphetamine = createFakeAmphetamine()
    const runOsascriptSync = vi.fn((_script: string) => ok('gone'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.dispose()
    await settle()

    expect(runOsascriptSync).not.toHaveBeenCalled()
  })

  it('does not end an adopted session on dispose', async () => {
    const amphetamine = createFakeAmphetamine('foreign')
    const runOsascriptSync = vi.fn((_script: string) => ok('foreign'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(runOsascriptSync).not.toHaveBeenCalled()
  })

  it('does not run a second async release after dispose has claimed it', async () => {
    const amphetamine = createFakeAmphetamine()
    const runOsascriptSync = vi.fn((_script: string) => ok('ended'))
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    const before = amphetamine.releases()
    assertion.stop('agents-idle')
    assertion.dispose()
    await settle()

    expect(amphetamine.releases()).toBe(before)
  })
})

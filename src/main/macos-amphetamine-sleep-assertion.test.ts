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

  it('does not claim a hold when the acquire output is unrecognized', async () => {
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (_script: string) => ok('garbage'))
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()

    expect(assertion.getHold()).toBeNull()
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
    expect(assertion.hasLiveHold()).toBe(true)

    amphetamine.run.mockImplementation(async (_script: string) =>
      failure('Not authorized to send Apple events to Amphetamine. (-1743)')
    )
    assertion.stop('agents-idle')
    await settle()

    // The hold survives for cleanup, but the attempt failed — vouching for it
    // here would let the router drop the caffeinate stand-in.
    expect(assertion.getHold()).toBe('owned')
    expect(assertion.hasLiveHold()).toBe(false)
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
    expect(assertion.hasLiveHold()).toBe(true)

    amphetamine.run.mockImplementation(async (_script: string) => failure('AppleEvent timed out'))
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    // The classification survives so a later stop can clean up...
    expect(assertion.getHold()).toBe('adopted')
    // ...but it is no longer evidence that anything is holding.
    expect(assertion.hasLiveHold()).toBe(false)
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
    expect(assertion.hasLiveHold()).toBe(false)

    // Recovery must not have to wait for the next re-check: once the backoff
    // window has passed, an untrusted hold is worth an Apple event on an
    // ordinary start rather than only on the next periodic one.
    clock += MACOS_AMPHETAMINE_ASSERTION_RETRY_MS + 1
    amphetamine.run.mockImplementation(async (_script: string) => ok('foreign'))
    const before = amphetamine.calls()
    assertion.start('agents-working')
    await settle()

    expect(amphetamine.calls()).toBeGreaterThan(before)
    expect(assertion.hasLiveHold()).toBe(true)
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

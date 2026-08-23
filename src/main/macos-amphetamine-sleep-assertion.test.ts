import { describe, expect, it, vi } from 'vitest'
import { MacosAmphetamineSleepAssertion } from './macos-amphetamine-sleep-assertion'
import type { AmphetamineSessionState, OsascriptResult } from './macos-amphetamine-session'

function ok(stdout = ''): OsascriptResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function failure(stderr: string, code = 1): OsascriptResult {
  return { code, stdout: '', stderr, timedOut: false }
}

const NO_SESSION: AmphetamineSessionState = {
  presence: 'idle',
  secondsRemaining: -3,
  isTrigger: false,
  displaySleepAllowed: false
}

const ORCA_SESSION: AmphetamineSessionState = {
  presence: 'active',
  secondsRemaining: 0,
  isTrigger: false,
  displaySleepAllowed: true
}

/** A 20-minute session with display sleep blocked — what a hand-started session looks like. */
const USER_TIMED_SESSION: AmphetamineSessionState = {
  presence: 'active',
  secondsRemaining: 1_199,
  isTrigger: false,
  displaySleepAllowed: false
}

const USER_TRIGGER_SESSION: AmphetamineSessionState = {
  presence: 'active',
  secondsRemaining: -1,
  isTrigger: true,
  displaySleepAllowed: false
}

/** Stands in for the single global session Amphetamine actually keeps. */
function createFakeAmphetamine(initial: AmphetamineSessionState = NO_SESSION) {
  let session = { ...initial }
  const scripts: string[] = []
  const run = vi.fn(async (script: string) => {
    scripts.push(script)
    if (script.includes('session is active')) {
      return ok(
        `${session.presence}|${session.secondsRemaining}|${session.isTrigger}|${session.displaySleepAllowed}`
      )
    }
    if (script.includes('start new session')) {
      session = { ...ORCA_SESSION }
      return ok()
    }
    if (script.includes('end session')) {
      session = { ...NO_SESSION }
      return ok()
    }
    return ok()
  })
  // Counted from the spy, not `scripts`, so a test that overrides the
  // implementation still gets accurate counts.
  const countScripts = (needle: string) =>
    run.mock.calls.filter(([script]) => script.includes(needle)).length
  return {
    run,
    scripts,
    starts: () => countScripts('start new session'),
    ends: () => countScripts('end session'),
    get session() {
      return session
    },
    setSession(next: AmphetamineSessionState) {
      session = { ...next }
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

describe('MacosAmphetamineSleepAssertion session ownership', () => {
  it('starts one indefinite session when nothing is running', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    assertion.start('agents-working')
    await settle()

    expect(amphetamine.starts()).toBe(1)
    expect(assertion.getHold()).toBe('owned')
  })

  it('adopts a session the user already started instead of replacing it', async () => {
    const amphetamine = createFakeAmphetamine(USER_TIMED_SESSION)
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()

    expect(amphetamine.starts()).toBe(0)
    expect(assertion.getHold()).toBe('adopted')
    expect(amphetamine.session).toMatchObject(USER_TIMED_SESSION)
  })

  it('never ends an adopted session', async () => {
    const amphetamine = createFakeAmphetamine(USER_TIMED_SESSION)
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    assertion.stop('agents-idle')
    await settle()

    expect(amphetamine.ends()).toBe(0)
    expect(amphetamine.session).toMatchObject(USER_TIMED_SESSION)
    expect(assertion.getHold()).toBeNull()
  })

  it('never replaces or ends a Trigger session', async () => {
    const amphetamine = createFakeAmphetamine(USER_TRIGGER_SESSION)
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    assertion.stop('agents-idle')
    await settle()

    expect(amphetamine.starts()).toBe(0)
    expect(amphetamine.ends()).toBe(0)
  })

  it('ends its own session on stop', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    assertion.stop('agents-idle')
    await settle()

    expect(amphetamine.ends()).toBe(1)
    expect(amphetamine.session.presence).toBe('idle')
    expect(assertion.getHold()).toBeNull()
  })

  it('leaves a session that replaced its own alone', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    // The user starts their own session, which implicitly ended Orca's.
    amphetamine.setSession(USER_TIMED_SESSION)
    assertion.stop('agents-idle')
    await settle()

    expect(amphetamine.ends()).toBe(0)
    expect(amphetamine.session).toMatchObject(USER_TIMED_SESSION)
  })

  it('does not end a session it cannot verify is still its own', async () => {
    const amphetamine = createFakeAmphetamine()
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    expect(assertion.getHold()).toBe('owned')

    // The user replaces Orca's session, and the read that would reveal it fails.
    amphetamine.setSession(USER_TIMED_SESSION)
    amphetamine.run.mockImplementation(async (script: string) =>
      script.includes('session is active') ? failure('AppleEvent timed out') : ok()
    )
    assertion.stop('agents-idle')
    await settle()

    // Ending blind here would kill the user's 20-minute session.
    expect(amphetamine.ends()).toBe(0)
    expect(assertion.getHold()).toBe('owned')
  })

  it('takes over when an adopted session expires', async () => {
    const amphetamine = createFakeAmphetamine(USER_TIMED_SESSION)
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()
    expect(assertion.getHold()).toBe('adopted')

    amphetamine.setSession(NO_SESSION)
    assertion.start('amphetamine-reconcile')
    await settle()

    expect(amphetamine.starts()).toBe(1)
    expect(assertion.getHold()).toBe('owned')
  })

  it('does not start a session when the state read is unparseable', async () => {
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (script: string) =>
      script.includes('session is active') ? ok('garbage') : ok()
    )
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()

    // Reading it as "no session" would start one on top of the user's.
    expect(amphetamine.starts()).toBe(0)
    expect(assertion.getHold()).toBeNull()
  })

  it('does not start a session when the state read fails', async () => {
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (script: string) =>
      script.includes('session is active') ? failure('AppleEvent timed out') : ok()
    )
    const assertion = createAssertion(amphetamine)

    assertion.start('agents-working')
    await settle()

    expect(amphetamine.starts()).toBe(0)
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

  it('does not spawn osascript in a loop when the probe keeps failing', async () => {
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (_script: string) => failure('AppleEvent timed out'))
    let assertion: MacosAmphetamineSleepAssertion | null = null
    // Mirrors AgentAwakeService: an unexpected failure refreshes, which starts again.
    const onUnexpectedFailure = vi.fn(() => {
      assertion?.start('refresh')
    })
    assertion = createAssertion(amphetamine, { now: () => 1_000, onUnexpectedFailure })

    assertion.start('agents-working')
    await settle()

    // One probe per backoff window, not one per refresh.
    expect(amphetamine.run.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('backs off and asks for a refresh after a transient failure', async () => {
    const onUnexpectedFailure = vi.fn()
    const amphetamine = createFakeAmphetamine()
    amphetamine.run.mockImplementation(async (script: string) =>
      script.includes('start new session')
        ? failure('AppleEvent timed out')
        : ok('idle|-3|false|false')
    )
    const assertion = createAssertion(amphetamine, {
      now: () => 1_000,
      onUnexpectedFailure
    })

    assertion.start('agents-working')
    await settle()
    expect(onUnexpectedFailure).toHaveBeenCalledWith('macos-amphetamine-assertion-failure')
    expect(assertion.isUnavailable()).toBe(false)

    assertion.start('agents-working')
    await settle()
    // Inside the retry window the next start must not issue another start.
    expect(amphetamine.starts()).toBe(1)
  })
})

describe('MacosAmphetamineSleepAssertion dispose', () => {
  it('ends its own session synchronously so quit cannot leak it', async () => {
    const amphetamine = createFakeAmphetamine()
    const runOsascriptSync = vi.fn((script: string) =>
      script.includes('session is active') ? ok('active|0|false|true') : ok()
    )
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(runOsascriptSync.mock.calls.some(([script]) => script.includes('end session'))).toBe(
      true
    )
  })

  it('leaves a replaced session alone on dispose', async () => {
    const amphetamine = createFakeAmphetamine()
    const runOsascriptSync = vi.fn((script: string) =>
      script.includes('session is active') ? ok('active|1199|false|false') : ok()
    )
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(runOsascriptSync.mock.calls.some(([script]) => script.includes('end session'))).toBe(
      false
    )
  })

  it('ends a session that started while quit was already in flight', async () => {
    const amphetamine = createFakeAmphetamine()
    let releaseStart = (): void => {}
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    amphetamine.run.mockImplementation(async (script: string) => {
      if (script.includes('session is active')) {
        return ok('idle|-3|false|false')
      }
      if (script.includes('start new session')) {
        await started
        return ok()
      }
      return ok()
    })
    const runOsascriptSync = vi.fn((script: string) =>
      script.includes('session is active') ? ok('active|0|false|true') : ok()
    )
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    // Quit lands while `start new session` is still in flight.
    assertion.dispose()
    releaseStart()
    await settle()

    expect(runOsascriptSync.mock.calls.some(([script]) => script.includes('end session'))).toBe(
      true
    )
    expect(assertion.getHold()).toBeNull()
  })

  it('does not end a session on dispose when the verifying read fails', async () => {
    const amphetamine = createFakeAmphetamine()
    const runOsascriptSync = vi.fn((script: string) =>
      script.includes('session is active') ? failure('AppleEvent timed out') : ok()
    )
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    // A leaked Orca session is one click away in Amphetamine's menu bar;
    // silently ending the user's is not recoverable.
    expect(runOsascriptSync.mock.calls.some(([script]) => script.includes('end session'))).toBe(
      false
    )
  })

  it('does not touch Amphetamine on dispose when it holds nothing', async () => {
    const amphetamine = createFakeAmphetamine()
    const runOsascriptSync = vi.fn((_script: string) => ok())
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.dispose()
    await settle()

    expect(runOsascriptSync).not.toHaveBeenCalled()
  })

  it('does not end an adopted session on dispose', async () => {
    const amphetamine = createFakeAmphetamine(USER_TIMED_SESSION)
    const runOsascriptSync = vi.fn((_script: string) => ok())
    const assertion = createAssertion(amphetamine, { runOsascriptSync })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(runOsascriptSync).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  classifyAmphetamineFailure,
  detectAmphetamineInstalled,
  MacosAmphetamineSleepAssertion,
  type OsascriptResult
} from './macos-amphetamine-sleep-assertion'

function ok(stdout = ''): OsascriptResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function failure(stderr: string, code = 1): OsascriptResult {
  return { code, stdout: '', stderr, timedOut: false }
}

function createLogger() {
  return { debug: vi.fn(), warn: vi.fn() }
}

/** Drain the microtask queue the assertion serializes its Apple events through. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

describe('detectAmphetamineInstalled', () => {
  it('reports installed when Launch Services resolves the bundle', async () => {
    const run = vi.fn(async (_script: string) => ok('/Applications/Amphetamine.app\n'))
    await expect(detectAmphetamineInstalled(run, 'darwin')).resolves.toBe(true)
  })

  it('reports not installed when the lookup fails', async () => {
    const run = vi.fn(async (_script: string) => failure('execution error: ... (-1728)'))
    await expect(detectAmphetamineInstalled(run, 'darwin')).resolves.toBe(false)
  })

  it('never probes off macOS', async () => {
    const run = vi.fn(async (_script: string) => ok('/Applications/Amphetamine.app'))
    await expect(detectAmphetamineInstalled(run, 'linux')).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('classifyAmphetamineFailure', () => {
  it('reads a missing bundle as not-installed', () => {
    expect(classifyAmphetamineFailure(failure('execution error: (-1728)'))).toBe('not-installed')
  })

  it('reads a refused Apple event as automation-denied', () => {
    expect(
      classifyAmphetamineFailure(failure('Not authorized to send Apple events to Amphetamine.'))
    ).toBe('automation-denied')
  })

  it('leaves transient failures unclassified so they retry', () => {
    expect(classifyAmphetamineFailure(failure('some other problem'))).toBeNull()
  })
})

describe('MacosAmphetamineSleepAssertion', () => {
  it('starts and ends exactly one session', async () => {
    const runOsascript = vi.fn(async (_script: string) => ok())
    const assertion = new MacosAmphetamineSleepAssertion({
      logger: createLogger(),
      platform: 'darwin',
      runOsascript
    })

    assertion.start('agents-working')
    assertion.start('agents-working')
    await settle()
    expect(runOsascript).toHaveBeenCalledTimes(1)
    expect(runOsascript.mock.calls[0][0]).toContain('start new session')

    assertion.stop('agents-idle')
    await settle()
    expect(runOsascript).toHaveBeenCalledTimes(2)
    expect(runOsascript.mock.calls[1][0]).toContain('end session')
  })

  it('never ends a session it did not start', async () => {
    const runOsascript = vi.fn(async (_script: string) => ok())
    const assertion = new MacosAmphetamineSleepAssertion({
      logger: createLogger(),
      platform: 'darwin',
      runOsascript
    })

    assertion.stop('agents-idle')
    await settle()
    expect(runOsascript).not.toHaveBeenCalled()
  })

  it('does nothing off macOS', async () => {
    const runOsascript = vi.fn(async (_script: string) => ok())
    const assertion = new MacosAmphetamineSleepAssertion({
      logger: createLogger(),
      platform: 'linux',
      runOsascript
    })

    assertion.start('agents-working')
    await settle()
    expect(runOsascript).not.toHaveBeenCalled()
  })

  it('goes unavailable and reports why when Amphetamine is missing', async () => {
    const onUnavailable = vi.fn()
    const runOsascript = vi.fn(async (_script: string) => failure('execution error: (-1728)'))
    const assertion = new MacosAmphetamineSleepAssertion({
      logger: createLogger(),
      onUnavailable,
      platform: 'darwin',
      runOsascript
    })

    assertion.start('agents-working')
    await settle()
    expect(onUnavailable).toHaveBeenCalledWith('not-installed')
    expect(assertion.isUnavailable()).toBe(true)

    assertion.start('agents-working')
    await settle()
    // Why once: an unusable engine must stop retrying so caffeinate keeps the session.
    expect(runOsascript).toHaveBeenCalledTimes(1)
  })

  it('goes unavailable when the Automation grant is refused', async () => {
    const onUnavailable = vi.fn()
    const assertion = new MacosAmphetamineSleepAssertion({
      logger: createLogger(),
      onUnavailable,
      platform: 'darwin',
      runOsascript: async () =>
        failure('Not authorized to send Apple events to Amphetamine. (-1743)')
    })

    assertion.start('agents-working')
    await settle()
    expect(onUnavailable).toHaveBeenCalledWith('automation-denied')
    expect(assertion.getUnavailableReason()).toBe('automation-denied')
  })

  it('backs off and asks for a refresh after a transient failure', async () => {
    const onUnexpectedFailure = vi.fn()
    const runOsascript = vi.fn(async (_script: string) => failure('AppleEvent timed out'))
    const assertion = new MacosAmphetamineSleepAssertion({
      logger: createLogger(),
      now: () => 1_000,
      onUnexpectedFailure,
      platform: 'darwin',
      runOsascript
    })

    assertion.start('agents-working')
    await settle()
    expect(onUnexpectedFailure).toHaveBeenCalledWith('macos-amphetamine-assertion-failure')
    expect(assertion.isUnavailable()).toBe(false)

    // Inside the retry window the next start must not spawn another osascript.
    assertion.start('agents-working')
    await settle()
    expect(runOsascript).toHaveBeenCalledTimes(1)
  })

  it('keeps the session tracked when ending it fails, so a later stop retries', async () => {
    const results = [ok(), failure('AppleEvent timed out'), ok()]
    const runOsascript = vi.fn(async (_script: string) => results.shift() ?? ok())
    const assertion = new MacosAmphetamineSleepAssertion({
      logger: createLogger(),
      platform: 'darwin',
      runOsascript
    })

    assertion.start('agents-working')
    await settle()
    assertion.stop('agents-idle')
    await settle()
    assertion.stop('agents-idle')
    await settle()

    expect(runOsascript).toHaveBeenCalledTimes(3)
    expect(runOsascript.mock.calls[2][0]).toContain('end session')
  })

  it('ends the session synchronously on dispose so quit cannot leak it', async () => {
    const runOsascriptSync = vi.fn((_script: string) => ok())
    const assertion = new MacosAmphetamineSleepAssertion({
      logger: createLogger(),
      platform: 'darwin',
      runOsascript: async () => ok(),
      runOsascriptSync
    })

    assertion.start('agents-working')
    await settle()
    assertion.dispose()

    expect(runOsascriptSync).toHaveBeenCalledTimes(1)
    expect(runOsascriptSync.mock.calls[0][0]).toContain('end session')
  })

  it('does not run a sync end when no session is held', async () => {
    const runOsascriptSync = vi.fn((_script: string) => ok())
    const assertion = new MacosAmphetamineSleepAssertion({
      logger: createLogger(),
      platform: 'darwin',
      runOsascript: async () => ok(),
      runOsascriptSync
    })

    assertion.dispose()
    await settle()
    expect(runOsascriptSync).not.toHaveBeenCalled()
  })
})

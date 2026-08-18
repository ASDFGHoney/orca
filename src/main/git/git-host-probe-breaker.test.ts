import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from '../crash-reporting/crash-breadcrumb-store'
import {
  _getGitHostProbeState,
  _resetGitHostProbeBreaker,
  GIT_HOST_PROBE_BASE_COOLDOWN_MS,
  GIT_HOST_PROBE_HEALTHY_CONCURRENCY,
  GIT_HOST_PROBE_MAX_COOLDOWN_MS,
  gitProbeHostKey,
  isGitHostProbeBlockedError,
  runGuardedGitHostProbe
} from './git-host-probe-breaker'

const isUnavailable = (error: unknown): boolean =>
  error instanceof Error && /timed out/i.test(error.message)

function timeout(): Error {
  return new Error('wsl.exe timed out.')
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Drives one probe to a settled outcome and reports whether it ran at all. */
async function probeOnce(
  hostKey: string,
  run: () => Promise<string>
): Promise<'answered' | 'unavailable' | 'blocked'> {
  try {
    await runGuardedGitHostProbe(hostKey, run, isUnavailable)
    return 'answered'
  } catch (error) {
    return isGitHostProbeBlockedError(error) ? 'blocked' : 'unavailable'
  }
}

describe('git host probe breaker', () => {
  beforeEach(() => {
    _resetGitHostProbeBreaker()
    clearCrashBreadcrumbsForTest()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetGitHostProbeBreaker()
  })

  it('scopes state to the runtime that executes git, never globally', () => {
    expect(gitProbeHostKey({})).toBe('native')
    expect(gitProbeHostKey({ wslDistro: 'Ubuntu-24.04' })).toBe('wsl:Ubuntu-24.04')
    expect(gitProbeHostKey({ connectionId: 'ssh-1', connectionGeneration: 3 })).toBe('ssh:ssh-1:3')
    // A reconnect mints a new key, so a fresh transport never serves the old
    // one's cooldown.
    expect(gitProbeHostKey({ connectionId: 'ssh-1', connectionGeneration: 4 })).not.toBe(
      gitProbeHostKey({ connectionId: 'ssh-1', connectionGeneration: 3 })
    )
  })

  it('leaves a single failure alone so a cold host is not punished for a blip', async () => {
    const run = vi.fn(async () => {
      throw timeout()
    })
    expect(await probeOnce('wsl:Ubuntu', run)).toBe('unavailable')

    const ok = vi.fn(async () => 'git@github.com:acme/orca.git')
    expect(await probeOnce('wsl:Ubuntu', ok)).toBe('answered')
    expect(ok).toHaveBeenCalledTimes(1)
    expect(_getGitHostProbeState('wsl:Ubuntu')).toBeNull()
  })

  it('opens after three consecutive unanswered probes and stops spawning', async () => {
    const run = vi.fn(async () => {
      throw timeout()
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await probeOnce('wsl:Ubuntu', run)).toBe('unavailable')
    }
    expect(run).toHaveBeenCalledTimes(3)

    for (let poll = 0; poll < 50; poll += 1) {
      expect(await probeOnce('wsl:Ubuntu', run)).toBe('blocked')
    }
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('escalates the cooldown per failed trial and caps it', async () => {
    const run = async (): Promise<string> => {
      throw timeout()
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await probeOnce('wsl:Ubuntu', run)
    }

    const cooldowns: number[] = []
    for (let trial = 0; trial < 4; trial += 1) {
      const state = _getGitHostProbeState('wsl:Ubuntu')
      cooldowns.push((state?.blockedUntilMs ?? 0) - Date.now())
      vi.setSystemTime(state?.blockedUntilMs ?? 0)
      expect(await probeOnce('wsl:Ubuntu', run)).toBe('unavailable')
    }

    expect(cooldowns).toEqual([
      GIT_HOST_PROBE_BASE_COOLDOWN_MS,
      GIT_HOST_PROBE_BASE_COOLDOWN_MS * 2,
      GIT_HOST_PROBE_MAX_COOLDOWN_MS,
      GIT_HOST_PROBE_MAX_COOLDOWN_MS
    ])
  })

  it('admits exactly one trial probe once the cooldown expires', async () => {
    const run = vi.fn(async () => {
      throw timeout()
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await probeOnce('wsl:Ubuntu', run)
    }
    run.mockClear()

    const trial = deferred<string>()
    vi.setSystemTime(Date.now() + GIT_HOST_PROBE_BASE_COOLDOWN_MS)
    const trialProbe = probeOnce('wsl:Ubuntu', () => trial.promise)
    await Promise.resolve()

    expect(await probeOnce('wsl:Ubuntu', run)).toBe('blocked')
    expect(run).not.toHaveBeenCalled()

    trial.resolve('git@github.com:acme/orca.git')
    expect(await trialProbe).toBe('answered')
  })

  it('serializes and sheds once a host has failed twice, but never before', async () => {
    const first = deferred<string>()
    const second = deferred<string>()

    // Healthy: concurrent probes run side by side.
    const healthyA = probeOnce('wsl:Ubuntu', () => first.promise)
    const healthyB = probeOnce('wsl:Ubuntu', () => second.promise)
    await Promise.resolve()
    first.reject(timeout())
    second.reject(timeout())
    expect(await healthyA).toBe('unavailable')
    expect(await healthyB).toBe('unavailable')

    // Degraded: a second concurrent probe is shed instead of queued.
    const held = deferred<string>()
    const outstanding = probeOnce('wsl:Ubuntu', () => held.promise)
    await Promise.resolve()
    const shedRun = vi.fn(async () => 'unused')
    expect(await probeOnce('wsl:Ubuntu', shedRun)).toBe('blocked')
    expect(shedRun).not.toHaveBeenCalled()

    held.resolve('git@github.com:acme/orca.git')
    expect(await outstanding).toBe('answered')
  })

  it('caps healthy concurrency and queues the overflow rather than failing it', async () => {
    const gates = Array.from({ length: GIT_HOST_PROBE_HEALTHY_CONCURRENCY + 3 }, () =>
      deferred<string>()
    )
    const started: number[] = []
    const probes = gates.map((gate, index) =>
      probeOnce('native', () => {
        started.push(index)
        return gate.promise
      })
    )
    await Promise.resolve()

    expect(started).toHaveLength(GIT_HOST_PROBE_HEALTHY_CONCURRENCY)
    for (const gate of gates) {
      gate.resolve('git@github.com:acme/orca.git')
    }
    expect(await Promise.all(probes)).toEqual(gates.map(() => 'answered'))
    expect(started).toHaveLength(gates.length)
  })

  it('treats a host answering "no such remote" as proof it is alive', async () => {
    const missing = async (): Promise<string> => {
      throw new Error("fatal: No such remote 'origin'")
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await probeOnce('wsl:Ubuntu', missing)).toBe('unavailable')
    }
    expect(_getGitHostProbeState('wsl:Ubuntu')).toBeNull()
  })

  it('keeps a wedged distro from gating a different host', async () => {
    const run = async (): Promise<string> => {
      throw timeout()
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await probeOnce('wsl:Ubuntu', run)
    }
    expect(await probeOnce('wsl:Ubuntu', run)).toBe('blocked')

    const native = vi.fn(async () => 'git@github.com:acme/orca.git')
    expect(await probeOnce('native', native)).toBe('answered')
    expect(await probeOnce('ssh:conn-1:0', native)).toBe('answered')
    expect(native).toHaveBeenCalledTimes(2)
  })

  it('leaves a durable breadcrumb for the outage and for the recovery', async () => {
    const wedged = async (): Promise<string> => {
      throw timeout()
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await probeOnce('wsl:Ubuntu', wedged)
    }

    const opened = getCrashBreadcrumbSnapshot().filter(
      (crumb) => crumb.name === 'git_host_probe_breaker_open'
    )
    expect(opened).toHaveLength(1)
    expect(opened[0]?.data).toMatchObject({ host: 'wsl:Ubuntu', unansweredProbes: 3 })

    // A wedged host must not turn one breadcrumb per failure into the noise it
    // was meant to explain.
    for (let trial = 0; trial < 6; trial += 1) {
      vi.setSystemTime(Date.now() + GIT_HOST_PROBE_MAX_COOLDOWN_MS)
      await probeOnce('wsl:Ubuntu', wedged)
    }
    expect(
      getCrashBreadcrumbSnapshot().filter((crumb) => crumb.name.startsWith('git_host_probe')).length
    ).toBeLessThanOrEqual(3)

    vi.setSystemTime(Date.now() + GIT_HOST_PROBE_MAX_COOLDOWN_MS)
    expect(await probeOnce('wsl:Ubuntu', async () => 'git@github.com:acme/orca.git')).toBe(
      'answered'
    )
    expect(
      getCrashBreadcrumbSnapshot().some((crumb) => crumb.name === 'git_host_probe_recovered')
    ).toBe(true)
  })
})

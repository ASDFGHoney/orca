import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteRuntimeEnvironmentReachable,
  retryRuntimeStatusRecoveryProbesNow,
  startRuntimeStatusRecoveryProbe,
  type RuntimeStatusRecoveryPort
} from './runtime-status-recovery-probe'

/**
 * Mirrors the two facts the real port bridges: what the store map currently records
 * (an id with a `null` status is "probed and unreachable") and what a fresh
 * `status.get` would actually answer. Only the probe's answer moves the record.
 */
function createPort(): {
  port: RuntimeStatusRecoveryPort
  refresh: ReturnType<typeof vi.fn>
  markUnverified: (environmentId: string) => void
  letHostAnswer: (environmentId: string) => void
} {
  const unverified = new Set<string>()
  const answeringHosts = new Set<string>()
  const statusChangeListeners = new Set<() => void>()
  const notifyStatusChanged = (): void => statusChangeListeners.forEach((listener) => listener())
  const refresh = vi.fn(async (environmentId: string) => {
    if (answeringHosts.has(environmentId)) {
      unverified.delete(environmentId)
      return true
    }
    unverified.add(environmentId)
    return false
  })
  return {
    port: {
      isRuntimeEnvironmentUnverified: (environmentId) => unverified.has(environmentId),
      listUnverifiedRuntimeEnvironmentIds: () => [...unverified],
      refreshRuntimeEnvironmentStatus: refresh,
      subscribeToRecordedStatusChanges: (onChange) => {
        statusChangeListeners.add(onChange)
        return () => statusChangeListeners.delete(onChange)
      }
    },
    refresh,
    markUnverified: (environmentId) => {
      unverified.add(environmentId)
      notifyStatusChanged()
    },
    letHostAnswer: (environmentId) => answeringHosts.add(environmentId)
  }
}

describe('runtime status recovery probe', () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  it('re-probes an unreachable host as soon as it answers a request', async () => {
    // The reported failure: one failed boot probe pinned a live host to a red
    // "disconnected" glyph for the whole session while its mirroring, agents and
    // terminals kept working over the same transport (#16516).
    const { port, refresh, markUnverified, letHostAnswer } = createPort()
    markUnverified('honey-mac')
    letHostAnswer('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    noteRuntimeEnvironmentReachable('honey-mac')
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledWith('honey-mac')
    expect(port.isRuntimeEnvironmentUnverified('honey-mac')).toBe(false)
  })

  it('ignores traffic to a host whose status is already known', () => {
    // Why: mirroring alone answers many requests a second. Only an entry stuck on
    // `null` is worth a probe; everything else must stay free.
    const { port, refresh } = createPort()
    stop = startRuntimeStatusRecoveryProbe(port)

    noteRuntimeEnvironmentReachable('honey-mac')

    expect(refresh).not.toHaveBeenCalled()
  })

  it('never reports a host reachable on traffic alone', async () => {
    // Why: docs/reference/ssh-execution-boundary.md — the probe's answer is the only
    // verdict. A host that answered one request but fails status.get stays unreachable.
    const { port, refresh, markUnverified } = createPort()
    markUnverified('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    noteRuntimeEnvironmentReachable('honey-mac')
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(refresh.mock.results[0].value).resolves.toBe(false)
  })

  it('coalesces a burst of traffic into one in-flight probe', async () => {
    const { port, refresh, markUnverified } = createPort()
    markUnverified('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    noteRuntimeEnvironmentReachable('honey-mac')
    noteRuntimeEnvironmentReachable('honey-mac')
    noteRuntimeEnvironmentReachable('honey-mac')

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps re-probing an unreachable host on a widening backoff', async () => {
    const { port, refresh, markUnverified } = createPort()
    markUnverified('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    // Still unreachable, so the next attempt waits twice as long.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('stops probing once a host answers and stays idle afterwards', async () => {
    const { port, refresh, markUnverified, letHostAnswer } = createPort()
    markUnverified('honey-mac')
    letHostAnswer('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    const callsAfterRecovery = refresh.mock.calls.length

    await vi.advanceTimersByTimeAsync(300_000)

    expect(refresh).toHaveBeenCalledTimes(callsAfterRecovery)
  })

  it('probes every unreachable host, not just the first', async () => {
    const { port, refresh, markUnverified } = createPort()
    markUnverified('honey-mac')
    markUnverified('openclaw')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(refresh.mock.calls.map(([id]) => id).sort()).toEqual(['honey-mac', 'openclaw'])
  })

  it('starts the clock for a host that goes unreachable after the app is running', async () => {
    // The real ordering: the probe starts with the app shell, before boot hydration
    // has recorded anything. An empty map at start must not leave it idle for good.
    const { port, refresh, markUnverified } = createPort()
    stop = startRuntimeStatusRecoveryProbe(port)

    markUnverified('honey-mac')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(refresh).toHaveBeenCalledWith('honey-mac')
  })

  it('backs each host off on its own clock', async () => {
    // Why: a shared deadline let a host that just started failing drag a
    // long-unreachable one back to the base interval on every sweep.
    const { port, refresh, markUnverified } = createPort()
    markUnverified('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    // honey-mac fails twice, so its next attempt is a full 20s out.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh.mock.calls.filter(([id]) => id === 'honey-mac')).toHaveLength(2)

    markUnverified('openclaw')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(refresh.mock.calls.filter(([id]) => id === 'openclaw')).toHaveLength(1)
    expect(refresh.mock.calls.filter(([id]) => id === 'honey-mac')).toHaveLength(2)
  })

  it('collapses the backoff when the machine comes back online', async () => {
    const { port, refresh, markUnverified } = createPort()
    markUnverified('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    retryRuntimeStatusRecoveryProbesNow()
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('probes nothing after it is stopped', async () => {
    const { port, refresh, markUnverified } = createPort()
    markUnverified('honey-mac')
    startRuntimeStatusRecoveryProbe(port)()

    noteRuntimeEnvironmentReachable('honey-mac')
    retryRuntimeStatusRecoveryProbesNow()
    await vi.advanceTimersByTimeAsync(300_000)

    expect(refresh).not.toHaveBeenCalled()
  })

  it('survives a probe that rejects', async () => {
    const { port, markUnverified } = createPort()
    markUnverified('honey-mac')
    const rejecting = {
      ...port,
      refreshRuntimeEnvironmentStatus: vi.fn(() => Promise.reject(new Error('transport closed')))
    }
    stop = startRuntimeStatusRecoveryProbe(rejecting)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(rejecting.refreshRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(rejecting.refreshRuntimeEnvironmentStatus).toHaveBeenCalledTimes(2)
  })
})

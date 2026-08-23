import { describe, expect, it, vi } from 'vitest'
import { AgentAwakeService } from './agent-awake-service'
import type { AgentAwakeServiceOptions, AgentAwakeStatus } from './agent-awake-service'

vi.mock('electron', () => ({
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn(), isStarted: vi.fn() }
}))

function workingStatus(): AgentAwakeStatus {
  return { state: 'working', receivedAt: 1_000, observedInCurrentRuntime: true }
}

function createBlocker() {
  const started = new Set<number>()
  let nextId = 1
  return {
    start: vi.fn(() => {
      const id = nextId++
      started.add(id)
      return id
    }),
    stop: vi.fn((id: number) => {
      started.delete(id)
    }),
    isStarted: vi.fn((id: number) => started.has(id))
  }
}

/** Models caffeinate reporting whether a process is actually held, not just that start() returned. */
function createCaffeinate() {
  let holding = false
  return {
    start: vi.fn(() => {
      holding = true
    }),
    stop: vi.fn(() => {
      holding = false
    }),
    dispose: vi.fn(),
    isHolding: vi.fn(() => holding),
    /** The spawn failed asynchronously, or the child exited. */
    loseProcess: () => {
      holding = false
    }
  }
}

/**
 * Models the real assertion's ASYNCHRONOUS acquisition.
 *
 * A fake that takes the hold synchronously inside start() hides the window this
 * engine has to cover: the first Apple event can block on the macOS Automation
 * consent dialog. Call `settleHold()` to represent that event completing.
 */
function createAmphetamine(unavailable = false) {
  let hold: 'owned' | 'adopted' | null = null
  let pending = false
  let degraded = false
  const listeners: (() => void)[] = []
  const fake = {
    start: vi.fn(() => {
      if (!unavailable) {
        pending = true
      }
    }),
    /** The acquire Apple event finally returns. */
    settleHold: (next: 'owned' | 'adopted' = 'owned') => {
      if (!pending) {
        return
      }
      pending = false
      degraded = false
      hold = next
      for (const listener of listeners) {
        listener()
      }
    },
    onHoldChanged: (listener: () => void) => listeners.push(listener),
    stop: vi.fn(() => {
      hold = null
      pending = false
    }),
    dispose: vi.fn(),
    isUnavailable: vi.fn(() => unavailable),
    getUnavailableReason: vi.fn(() => (unavailable ? ('not-installed' as const) : null)),
    // A no-op here: recovery is re-discovered by the next real attempt, so the
    // double must not decide the engine became usable on its own.
    clearUnavailable: vi.fn(),
    getHold: vi.fn(() => hold),
    hasLiveHold: vi.fn(() => hold !== null && !degraded),
    /** A failed attempt: the classification survives but is no longer proof. */
    degrade: () => {
      degraded = true
    }
  }
  return fake
}

function createService(overrides: AgentAwakeServiceOptions = {}): {
  service: AgentAwakeService
  caffeinate: ReturnType<typeof createCaffeinate>
  amphetamine: ReturnType<typeof createAmphetamine>
} {
  const caffeinate = overrides.macosAssertion ?? createCaffeinate()
  const amphetamine = overrides.macosAmphetamineAssertion ?? createAmphetamine()
  const service = new AgentAwakeService({
    blocker: createBlocker(),
    detectAmphetamine: async () => true,
    linuxAssertion: createCaffeinate(),
    logger: { debug: vi.fn(), warn: vi.fn() },
    macosAmphetamineAssertion: amphetamine,
    macosAssertion: caffeinate,
    now: () => 1_000,
    platform: 'darwin',
    powerMonitor: null,
    ...overrides
  })
  return {
    service,
    caffeinate: caffeinate as ReturnType<typeof createCaffeinate>,
    amphetamine: amphetamine as ReturnType<typeof createAmphetamine>
  }
}

/**
 * The invariant three separate review rounds each found a hole in: while Orca
 * wants the Mac awake, at least one native assertion must be held. Table-driven
 * so a new edge case fails here rather than needing someone to spot it.
 */
describe('AgentAwakeService macOS coverage invariant', () => {
  it.each([
    ['caffeinate engine', 'caffeinate' as const, null, false],
    ['Amphetamine still acquiring', 'amphetamine' as const, null, false],
    ['Amphetamine owning a live session', 'amphetamine' as const, 'owned' as const, false],
    ['Amphetamine only adopting', 'amphetamine' as const, 'adopted' as const, false],
    ['Amphetamine hold no longer live', 'amphetamine' as const, 'owned' as const, true]
  ])('holds something with %s', (_label, engine, hold, degraded) => {
    const amphetamine = createAmphetamine()
    const caffeinate = createCaffeinate()
    const { service } = createService({
      macosAmphetamineAssertion: amphetamine,
      macosAssertion: caffeinate
    })

    service.setMacosEngine(engine)
    service.setMode('on')
    if (hold) {
      amphetamine.settleHold(hold)
    }
    if (degraded) {
      amphetamine.degrade()
    }
    service.setStatuses([])

    const amphetamineHolding =
      amphetamine.start.mock.calls.length > 0 && amphetamine.getHold() !== null && !degraded
    const caffeinateHolding = caffeinate.start.mock.calls.length > caffeinate.stop.mock.calls.length
    expect(amphetamineHolding || caffeinateHolding).toBe(true)
  })

  it('does not release Amphetamine when caffeinate accepted start but holds nothing', () => {
    const amphetamine = createAmphetamine()
    const caffeinate = createCaffeinate()
    // start() returns normally, but no process is actually held — an async
    // spawn failure looks exactly like this.
    caffeinate.start.mockImplementation(() => {})
    caffeinate.isHolding.mockReturnValue(false)
    const { service } = createService({
      macosAmphetamineAssertion: amphetamine,
      macosAssertion: caffeinate
    })

    service.setMacosEngine('amphetamine')
    service.setMode('on')
    amphetamine.settleHold('owned')
    service.setStatuses([])
    amphetamine.stop.mockClear()

    service.setMacosEngine('caffeinate')

    expect(amphetamine.stop).not.toHaveBeenCalled()
  })

  it('drops the caffeinate stand-in once the hold actually lands', () => {
    // Coverage depends on a refresh firing when the hold changes; without it
    // caffeinate would stay up alongside Amphetamine indefinitely.
    const amphetamine = createAmphetamine()
    const caffeinate = createCaffeinate()
    const { service } = createService({
      macosAmphetamineAssertion: amphetamine,
      macosAssertion: caffeinate
    })
    const refreshes: string[] = []
    amphetamine.onHoldChanged(() => refreshes.push('hold-changed'))

    service.setMacosEngine('amphetamine')
    service.setMode('on')
    expect(caffeinate.start).toHaveBeenCalled()
    caffeinate.stop.mockClear()

    amphetamine.settleHold('owned')
    service.setStatuses([])

    expect(caffeinate.stop).toHaveBeenCalled()
  })

  it('holds something even when the incoming engine cannot start', () => {
    const amphetamine = createAmphetamine()
    const caffeinate = createCaffeinate()
    caffeinate.start.mockImplementation(() => {
      throw new Error('caffeinate spawn failed')
    })
    caffeinate.isHolding.mockReturnValue(false)
    const { service } = createService({
      macosAmphetamineAssertion: amphetamine,
      macosAssertion: caffeinate
    })

    service.setMacosEngine('amphetamine')
    service.setMode('on')
    amphetamine.settleHold('owned')
    service.setStatuses([])
    // Ignore the legitimate stop from the first engine change, which happened
    // while the mode was still off.
    amphetamine.stop.mockClear()
    service.setMacosEngine('caffeinate')

    // caffeinate never took over, so Amphetamine must not have been released.
    expect(amphetamine.stop).not.toHaveBeenCalled()
  })
})

describe('AgentAwakeService macOS engine selection', () => {
  it('holds the session with caffeinate by default', () => {
    const { service, caffeinate, amphetamine } = createService()

    service.setMode('on')

    expect(caffeinate.start).toHaveBeenCalledTimes(1)
    expect(amphetamine.start).not.toHaveBeenCalled()
  })

  it('switches a live session from caffeinate to Amphetamine', () => {
    const { service, caffeinate, amphetamine } = createService()

    service.setMode('on')
    caffeinate.stop.mockClear()
    service.setMacosEngine('amphetamine')

    expect(amphetamine.start).toHaveBeenCalled()
    // The Apple event has not returned yet: releasing caffeinate here would
    // leave nothing holding a lid-close-proof assertion.
    expect(caffeinate.stop).not.toHaveBeenCalled()

    amphetamine.settleHold()
    service.setStatuses([])

    expect(caffeinate.stop).toHaveBeenCalled()
  })

  it('never lets both engines hold a session at once', () => {
    const { service, caffeinate, amphetamine } = createService()

    service.setMacosEngine('amphetamine')
    service.setMode('on')

    expect(amphetamine.start).toHaveBeenCalled()
    // caffeinate stands in until the hold lands, then steps down.
    expect(caffeinate.start).toHaveBeenCalled()
    amphetamine.settleHold()
    service.setStatuses([])
    expect(caffeinate.stop).toHaveBeenCalled()
  })

  it('falls back to caffeinate when Amphetamine is unusable', () => {
    const amphetamine = createAmphetamine(true)
    const { service, caffeinate } = createService({ macosAmphetamineAssertion: amphetamine })

    service.setMacosEngine('amphetamine')
    service.setMode('on')

    expect(amphetamine.start).not.toHaveBeenCalled()
    expect(caffeinate.start).toHaveBeenCalledTimes(1)
  })

  it('keeps a known install state when a later probe cannot tell', async () => {
    const amphetamine = createAmphetamine()
    const probe = vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(true)
    const { service } = createService({
      macosAmphetamineAssertion: amphetamine,
      detectAmphetamine: probe
    })

    await service.probeAmphetamine()
    expect(service.getStatus().amphetamineInstalled).toBe(true)

    // A transient probe failure must not read as "the app went away".
    probe.mockResolvedValue(undefined)
    await service.probeAmphetamine()

    expect(service.getStatus().amphetamineInstalled).toBe(true)
  })

  it('retries a previously unusable engine when the user re-picks it', () => {
    const amphetamine = createAmphetamine(true)
    const { service } = createService({ macosAmphetamineAssertion: amphetamine })

    service.setMacosEngine('amphetamine')
    amphetamine.clearUnavailable.mockClear()
    // Re-picking is the retry gesture after fixing a refused Automation grant.
    service.setMacosEngine('amphetamine')

    expect(amphetamine.clearUnavailable).toHaveBeenCalled()
  })

  it('keeps caffeinate when Amphetamine only adopted a session it does not own', () => {
    const amphetamine = createAmphetamine()
    const { service, caffeinate } = createService({ macosAmphetamineAssertion: amphetamine })

    service.setMacosEngine('amphetamine')
    service.setMode('on')
    // An adopted session is the user's and may be a timer that expires between
    // re-checks, so caffeinate must stay as the safety net.
    amphetamine.settleHold('adopted')
    caffeinate.stop.mockClear()
    service.setStatuses([])

    expect(caffeinate.stop).not.toHaveBeenCalled()
    expect(caffeinate.start).toHaveBeenCalled()
  })

  it('does not release Amphetamine when caffeinate fails to take over', () => {
    const amphetamine = createAmphetamine()
    const caffeinate = createCaffeinate()
    caffeinate.start.mockImplementation(() => {
      throw new Error('caffeinate spawn failed')
    })
    caffeinate.isHolding.mockReturnValue(false)
    const { service } = createService({
      macosAmphetamineAssertion: amphetamine,
      macosAssertion: caffeinate
    })

    service.setMacosEngine('amphetamine')
    service.setMode('on')
    amphetamine.settleHold('owned')
    service.setStatuses([])
    amphetamine.stop.mockClear()

    // Switching back with a broken caffeinate must not end the last assertion.
    service.setMacosEngine('caffeinate')

    expect(amphetamine.stop).not.toHaveBeenCalled()
  })

  it('keeps caffeinate up when a hold classification is no longer proof', () => {
    const amphetamine = createAmphetamine()
    const { service, caffeinate } = createService({ macosAmphetamineAssertion: amphetamine })

    service.setMacosEngine('amphetamine')
    service.setMode('on')
    amphetamine.settleHold('adopted')
    service.setStatuses([])
    expect(caffeinate.stop).toHaveBeenCalled()

    // A failed re-check retains the classification so a later stop can clean
    // up, but it no longer proves anything is holding.
    caffeinate.start.mockClear()
    amphetamine.degrade()
    service.setStatuses([])

    expect(caffeinate.start).toHaveBeenCalled()
  })

  it('publishes the engine and its availability to subscribers', async () => {
    const { service } = createService()
    const seen: unknown[] = []
    service.subscribe((status) => seen.push(status))

    await service.probeAmphetamine()
    service.setMacosEngine('amphetamine')
    service.setMode('auto')
    service.setStatuses([workingStatus()])

    expect(service.getStatus()).toMatchObject({
      mode: 'auto',
      active: true,
      macosEngine: 'amphetamine',
      amphetamineInstalled: true
    })
    expect(seen.length).toBeGreaterThan(0)
  })

  it('omits macOS engine fields off macOS', () => {
    const { service } = createService({ platform: 'linux' })

    service.setMode('on')

    expect(service.getStatus()).toEqual({ mode: 'on', active: true })
  })

  it('releases both engines on dispose', () => {
    const { service, caffeinate, amphetamine } = createService()

    service.dispose()

    expect(caffeinate.dispose).toHaveBeenCalledTimes(1)
    expect(amphetamine.dispose).toHaveBeenCalledTimes(1)
  })
})

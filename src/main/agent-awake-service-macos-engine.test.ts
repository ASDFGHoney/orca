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

function createCaffeinate() {
  return { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() }
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

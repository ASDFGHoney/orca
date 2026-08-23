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

/**
 * Coverage is now structural rather than negotiated: caffeinate runs whenever
 * Orca wants the Mac awake, and Amphetamine is additive on top. Three review
 * rounds each found a different sequence where a handover left nothing held, and
 * no liveness answer about caffeinate can be trusted at the moment it is read —
 * so there is no handover to get wrong.
 */
describe('AgentAwakeService macOS coverage', () => {
  it.each([
    ['caffeinate engine', 'caffeinate' as const, null],
    ['Amphetamine still acquiring', 'amphetamine' as const, null],
    ['Amphetamine owning a live session', 'amphetamine' as const, 'owned' as const],
    ['Amphetamine only adopting', 'amphetamine' as const, 'adopted' as const]
  ])('keeps caffeinate held with %s', (_label, engine, hold) => {
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
    caffeinate.stop.mockClear()
    service.setStatuses([])

    expect(caffeinate.start).toHaveBeenCalled()
    expect(caffeinate.stop).not.toHaveBeenCalled()
  })

  it('still holds caffeinate when Amphetamine cannot be used at all', () => {
    const amphetamine = createAmphetamine(true)
    const caffeinate = createCaffeinate()
    const { service } = createService({
      macosAmphetamineAssertion: amphetamine,
      macosAssertion: caffeinate
    })

    service.setMacosEngine('amphetamine')
    service.setMode('on')

    expect(caffeinate.start).toHaveBeenCalled()
    expect(amphetamine.start).not.toHaveBeenCalled()
  })

  it('releases both once Orca no longer wants the Mac awake', () => {
    const amphetamine = createAmphetamine()
    const caffeinate = createCaffeinate()
    const { service } = createService({
      macosAmphetamineAssertion: amphetamine,
      macosAssertion: caffeinate
    })

    service.setMacosEngine('amphetamine')
    service.setMode('on')
    amphetamine.settleHold('owned')
    service.setMode('off')

    expect(caffeinate.stop).toHaveBeenCalled()
    expect(amphetamine.stop).toHaveBeenCalled()
  })
})

describe('AgentAwakeService macOS engine selection', () => {
  it('holds the session with caffeinate by default', () => {
    const { service, caffeinate, amphetamine } = createService()

    service.setMode('on')

    expect(caffeinate.start).toHaveBeenCalledTimes(1)
    expect(amphetamine.start).not.toHaveBeenCalled()
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

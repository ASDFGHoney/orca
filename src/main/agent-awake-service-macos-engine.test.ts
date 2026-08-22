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

function createAmphetamine(unavailable = false) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    isUnavailable: vi.fn(() => unavailable),
    getUnavailableReason: vi.fn(() => (unavailable ? ('not-installed' as const) : null))
  }
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

    expect(caffeinate.stop).toHaveBeenCalled()
    expect(amphetamine.start).toHaveBeenCalledTimes(1)
  })

  it('never lets both engines hold a session at once', () => {
    const { service, caffeinate, amphetamine } = createService()

    service.setMacosEngine('amphetamine')
    service.setMode('on')

    expect(amphetamine.start).toHaveBeenCalledTimes(1)
    expect(caffeinate.start).not.toHaveBeenCalled()
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

import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

// Why: the presence map has no accessor — the runtime exposes only the driver it derives.
type PresenceInternals = {
  mobileSubscribers: Map<string, Map<string, { viewport: { cols: number; rows: number } | null }>>
  pendingSoftLeavers: Map<string, { clientId: string }>
}

type Observed = { presenceAtUnsubscribe: string[] | null; tookGraceBranch: boolean }

const internalsOf = (runtime: OrcaRuntimeService): PresenceInternals =>
  runtime as unknown as PresenceInternals

const presenceOf = (runtime: OrcaRuntimeService, ptyId: string): string[] => [
  ...(internalsOf(runtime).mobileSubscribers.get(ptyId)?.keys() ?? [])
]

const viewportOf = (
  runtime: OrcaRuntimeService,
  ptyId: string,
  clientId: string
): { cols: number; rows: number } | null | undefined =>
  internalsOf(runtime).mobileSubscribers.get(ptyId)?.get(clientId)?.viewport

const VIEWPORT = { cols: 40, rows: 20 }

const subscribeRequest: RpcRequest = {
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-1',
    client: { id: 'phone-1', type: 'mobile' },
    viewport: VIEWPORT,
    capabilities: { terminalBinaryStream: 1 }
  }
}

/**
 * Real presence methods behind the stubs the binary view stream needs. Everything
 * that touches `mobileSubscribers` is the production implementation; only the PTY,
 * scrollback and graph lookups are doubled.
 */
const createViewStreamRuntime = (
  real: OrcaRuntimeService,
  observed: Observed
): OrcaRuntimeService => {
  const registry = createSubscriptionRegistryDouble()
  return {
    getRuntimeId: () => 'test-runtime',
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: (ptyId: string, clientId: string, viewport?: typeof VIEWPORT) => {
      // Why read it here and not before dispatch: the soft-leave timer is real and
      // unfaked, so a slow dispatch would expire it and silently downgrade the
      // resubscribe-grace case into a duplicate of the fresh-subscribe one.
      observed.tookGraceBranch =
        internalsOf(real).pendingSoftLeavers.get(ptyId)?.clientId === clientId
      return real.handleMobileSubscribe(ptyId, clientId, viewport)
    },
    handleMobileUnsubscribe: (ptyId: string, clientId: string) => {
      // The whole invariant in one reading: what the teardown sees when it runs.
      observed.presenceAtUnsubscribe = presenceOf(real, ptyId)
      real.handleMobileUnsubscribe(ptyId, clientId)
    },
    getDriver: (ptyId: string) => real.getDriver(ptyId),
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    getRendererTerminalSerializerGeneration: () => 0,
    waitForRendererTerminalSerializer: async () => false,
    getPtyOutputSequence: () => 0,
    replaceHeadlessTerminalFromRendererSnapshotForRecovery: () => {},
    serializeRendererTerminalBuffer: async () => null,
    hasHeadlessTerminalState: () => true,
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'x', cols: 80, rows: 24, seq: 4 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    // Why: what graph churn really does to the subscribe exit-waiter — see
    // markGraphUnavailable / markRendererReloading, which reject every outstanding waiter.
    waitForTerminal: vi.fn(() => Promise.reject(new Error('terminal_handle_stale')))
  } as unknown as OrcaRuntimeService
}

const dispatchTornDownSubscribe = async (real: OrcaRuntimeService): Promise<Observed> => {
  const observed: Observed = { presenceAtUnsubscribe: null, tookGraceBranch: false }
  const dispatcher = new RpcDispatcher({
    runtime: createViewStreamRuntime(real, observed),
    methods: TERMINAL_METHODS
  })
  await dispatcher.dispatchStreaming(subscribeRequest, vi.fn(), {
    connectionId: 'conn-phone',
    sendBinary: vi.fn(),
    registerBinaryStreamHandler: vi.fn(() => vi.fn())
  })
  return observed
}

// Division of labour: the two handler cases pin the end-to-end outcome for the graph-churn
// trigger, whose teardown is delivered a fixed two microtasks deep — so they only fire once a
// presence write slips past that. The direct case below is the minimal-delta guard: it catches
// a single-tick yield, which other teardown triggers can deliver arbitrarily early.
describe('mobile view stream presence release', () => {
  it('leaves no presence when cleanup wins a fresh awaited subscribe', async () => {
    const real = new OrcaRuntimeService()

    const observed = await dispatchTornDownSubscribe(real)

    expect(observed.tookGraceBranch).toBe(false)
    // The teardown lands after the presence write, so its release is the one that survives.
    expect(observed.presenceAtUnsubscribe).toEqual(['phone-1'])
    expect(presenceOf(real, 'pty-1')).toEqual([])
    // The soft-leave grace holds driver=mobile briefly, then releases the input lock.
    await vi.waitFor(() => expect(real.getDriver('pty-1')).toEqual({ kind: 'idle' }), {
      timeout: 3000
    })
  })

  it('leaves no presence when cleanup wins a resubscribe-grace subscribe', async () => {
    const real = new OrcaRuntimeService()
    // Arm the soft-leaver so the subscribe takes the resubscribe-grace branch — the one a
    // phone hits on background→foreground or a reconnect inside the 250ms window.
    await real.handleMobileSubscribe('pty-1', 'phone-1', VIEWPORT)
    real.handleMobileUnsubscribe('pty-1', 'phone-1')
    expect(internalsOf(real).pendingSoftLeavers.has('pty-1')).toBe(true)

    const observed = await dispatchTornDownSubscribe(real)

    expect(observed.tookGraceBranch).toBe(true)
    expect(observed.presenceAtUnsubscribe).toEqual(['phone-1'])
    expect(presenceOf(real, 'pty-1')).toEqual([])
    await vi.waitFor(() => expect(real.getDriver('pty-1')).toEqual({ kind: 'idle' }), {
      timeout: 3000
    })
  })

  it('records presence before the first await on both subscribe branches', async () => {
    const real = new OrcaRuntimeService()

    // Fresh-subscribe branch.
    const fresh = real.handleMobileSubscribe('pty-1', 'phone-1', VIEWPORT)
    // This is what makes the view branch's missing release harmless: the phone-fit
    // await happens after the map write, never before it.
    expect(presenceOf(real, 'pty-1')).toEqual(['phone-1'])
    real.handleMobileUnsubscribe('pty-1', 'phone-1')
    expect(presenceOf(real, 'pty-1')).toEqual([])
    await fresh
    expect(presenceOf(real, 'pty-1')).toEqual([])

    // Resubscribe-grace branch — same ordering, separate code path.
    await real.handleMobileSubscribe('pty-2', 'phone-1', VIEWPORT)
    real.handleMobileUnsubscribe('pty-2', 'phone-1')
    const grace = real.handleMobileSubscribe('pty-2', 'phone-1', VIEWPORT)
    expect(presenceOf(real, 'pty-2')).toEqual(['phone-1'])
    real.handleMobileUnsubscribe('pty-2', 'phone-1')
    expect(presenceOf(real, 'pty-2')).toEqual([])
    await grace
    expect(presenceOf(real, 'pty-2')).toEqual([])
  })

  it('cannot tell a late release apart from the record that replaced it', async () => {
    const real = new OrcaRuntimeService()

    await real.handleMobileSubscribe('pty-1', 'phone-1', VIEWPORT)
    real.handleMobileUnsubscribe('pty-1', 'phone-1')
    await real.handleMobileSubscribe('pty-1', 'phone-1', { cols: 41, rows: 21 })
    // The record under (ptyId, clientId) is the later handler's, not a revival of the first.
    expect(viewportOf(real, 'pty-1', 'phone-1')).toEqual({ cols: 41, rows: 21 })

    // Presence is keyed only by (ptyId, clientId), so a superseded handler copying the
    // lease-only guard runs exactly this and strands a live stream with no presence.
    real.handleMobileUnsubscribe('pty-1', 'phone-1')
    expect(presenceOf(real, 'pty-1')).toEqual([])
    expect(real.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-1' })
  })
})

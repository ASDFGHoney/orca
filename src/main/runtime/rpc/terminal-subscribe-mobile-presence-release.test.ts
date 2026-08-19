import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

// Why: the presence map has no accessor — the runtime exposes only the driver it derives.
type PresenceInternals = {
  mobileSubscribers: Map<string, Map<string, unknown>>
}

const presenceOf = (runtime: OrcaRuntimeService, ptyId: string): string[] => [
  ...((runtime as unknown as PresenceInternals).mobileSubscribers.get(ptyId)?.keys() ?? [])
]

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
const createViewStreamRuntime = (real: OrcaRuntimeService, calls: string[]): OrcaRuntimeService => {
  const registry = createSubscriptionRegistryDouble()
  return {
    getRuntimeId: () => 'test-runtime',
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: async (ptyId: string, clientId: string, viewport?: typeof VIEWPORT) => {
      calls.push('subscribe:enter')
      const result = await real.handleMobileSubscribe(ptyId, clientId, viewport)
      calls.push('subscribe:exit')
      return result
    },
    handleMobileUnsubscribe: (ptyId: string, clientId: string) => {
      calls.push('unsubscribe')
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

describe('mobile view stream presence release', () => {
  it('leaves no mobile presence when subscription cleanup wins the awaited subscribe', async () => {
    const real = new OrcaRuntimeService()
    const calls: string[] = []
    const runtime = createViewStreamRuntime(real, calls)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(subscribeRequest, vi.fn(), {
      connectionId: 'conn-phone',
      sendBinary: vi.fn(),
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })

    // The teardown lands inside the awaited subscribe, not before it — so the
    // release it performs is the one that survives.
    expect(calls).toEqual(['subscribe:enter', 'unsubscribe', 'subscribe:exit'])
    expect(presenceOf(real, 'pty-1')).toEqual([])
    // The soft-leave grace holds driver=mobile briefly, then releases the input lock.
    await vi.waitFor(() => expect(real.getDriver('pty-1')).toEqual({ kind: 'idle' }), {
      timeout: 3000
    })
  })

  it('records mobile presence before its first await so a concurrent unsubscribe wins', async () => {
    const real = new OrcaRuntimeService()

    const subscribing = real.handleMobileSubscribe('pty-1', 'phone-1', VIEWPORT)
    // This is what makes the view branch's missing release harmless: the phone-fit
    // await happens after the map write, never before it.
    expect(presenceOf(real, 'pty-1')).toEqual(['phone-1'])

    real.handleMobileUnsubscribe('pty-1', 'phone-1')
    expect(presenceOf(real, 'pty-1')).toEqual([])

    await subscribing
    expect(presenceOf(real, 'pty-1')).toEqual([])
  })

  it('cannot distinguish a superseded handler from its replacement by (ptyId, clientId)', async () => {
    const real = new OrcaRuntimeService()

    await real.handleMobileSubscribe('pty-1', 'phone-1', VIEWPORT)
    real.handleMobileUnsubscribe('pty-1', 'phone-1')
    await real.handleMobileSubscribe('pty-1', 'phone-1', { cols: 41, rows: 21 })
    expect(presenceOf(real, 'pty-1')).toEqual(['phone-1'])

    // A superseded handler copying the lease-only guard would run exactly this and
    // strand the replacement's live stream with no presence and a mobile driver.
    real.handleMobileUnsubscribe('pty-1', 'phone-1')
    expect(presenceOf(real, 'pty-1')).toEqual([])
    expect(real.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-1' })
  })
})

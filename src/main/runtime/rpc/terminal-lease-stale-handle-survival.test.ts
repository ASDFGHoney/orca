/**
 * A lease-only subscribe must survive an exit-waiter REJECTION.
 *
 * `waitForTerminal(..., 'exit')` rejects with `terminal_handle_stale` whenever the handle cannot be
 * resolved right now — most loudly when `record.rendererGraphEpoch !== this.rendererGraphEpoch`,
 * which every renderer graph reload causes. That is not evidence the PTY exited. Retiring the lease
 * on it makes the host emit `end` on a live pane, and mobile reads three of those as "PTY gone"
 * before it stops asking (`MAX_REARM_ATTEMPTS`), stranding the composer on "Waiting for terminal…"
 * for as long as the handle is unchanged.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const leaseRequest: RpcRequest = {
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-1',
    client: { id: 'phone-1', type: 'mobile' },
    viewport: { cols: 40, rows: 20 },
    capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
  }
}

function createRuntime(waitForTerminal: () => Promise<RuntimeTerminalWait>, provenAbsent = false) {
  const registry = createSubscriptionRegistryDouble()
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn(),
    registerRemoteTerminalViewSubscriber: vi.fn(),
    readTerminal: vi.fn(),
    serializeTerminalBuffer: vi.fn(),
    subscribeToTerminalResize: vi.fn(),
    subscribeToFitOverrideChanges: vi.fn(),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    // The PTY is alive: nothing has proven it absent.
    isLeafPtyProvenAbsent: vi.fn().mockResolvedValue(provenAbsent),
    waitForTerminal: vi.fn(waitForTerminal)
  } as unknown as OrcaRuntimeService
  return runtime
}

function dispatchLease(runtime: OrcaRuntimeService, messages: string[]) {
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  return dispatcher.dispatchStreaming(leaseRequest, (message) => messages.push(message), {
    connectionId: 'conn-phone',
    sendBinary: vi.fn(),
    registerBinaryStreamHandler: vi.fn(() => vi.fn())
  })
}

function frameTypes(messages: string[]): string[] {
  return messages.flatMap((message) => {
    const type = JSON.parse(message).result?.type
    return typeof type === 'string' ? [type] : []
  })
}

describe('lease-only subscribe against a stale handle', () => {
  it('keeps the lease when the exit wait rejects with a stale handle', async () => {
    const messages: string[] = []
    // A renderer graph reload invalidates the handle record; the PTY is untouched.
    const runtime = createRuntime(() => Promise.reject(new Error('terminal_handle_stale')))

    void dispatchLease(runtime, messages)

    await vi.waitFor(() => expect(frameTypes(messages)).toContain('subscribed'))
    // Give the rejected waiter every chance to retire the lease behind our back.
    await Promise.resolve()
    await Promise.resolve()

    expect(frameTypes(messages)).not.toContain('end')
    expect(runtime.handleMobileUnsubscribe).not.toHaveBeenCalled()
  })

  it('retires the lease when the PTY is proven absent', async () => {
    const messages: string[] = []
    // Same stale-handle rejection, but the provider's inventory says the process is gone. That is
    // proof, so the subscription must still be retired rather than leaked (the #14992 property).
    const runtime = createRuntime(() => Promise.reject(new Error('terminal_handle_stale')), true)

    void dispatchLease(runtime, messages)

    await vi.waitFor(() => expect(frameTypes(messages)).toContain('end'))
    expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledWith('pty-1', 'phone-1')
  })

  it('still retires the lease when the terminal actually exits', async () => {
    const messages: string[] = []
    const exited: RuntimeTerminalWait = {
      handle: 'terminal-1',
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 0
    }
    const runtime = createRuntime(() => Promise.resolve(exited))

    void dispatchLease(runtime, messages)

    // Why this case: the guard must narrow the REJECTION leg only. A real exit resolves, and it
    // must still tear the lease down — otherwise a dead pane holds the mobile input floor forever.
    await vi.waitFor(() => expect(frameTypes(messages)).toContain('end'))
    expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledWith('pty-1', 'phone-1')
  })
})

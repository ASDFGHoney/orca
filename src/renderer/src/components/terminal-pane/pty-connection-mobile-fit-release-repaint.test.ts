import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import type { setFitOverride as SetFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import type { setDriverForPty as SetDriverForPty } from '@/lib/pane-manager/mobile-driver-state'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({ scheduleTerminalWebglAtlasRecovery }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

const PHONE = { cols: 45, rows: 20 }
const DESKTOP = { cols: 120, rows: 40 }
// The pty id the store fixture binds to this tab's pane.
const PTY_ID = 'tab-pty'

/** Mirrors the real fit: proposeDimensions reports the desktop box, and a fit
 *  moves xterm's grid onto it. The mobile-fit hold parks it at phone dims. */
function makeDesktopFittingPane(paneId: number): MockPane {
  const pane = createPane(paneId)
  pane.fitAddon.proposeDimensions.mockImplementation(() => DESKTOP)
  pane.fitAddon.fit.mockImplementation(() => {
    pane.terminal.cols = DESKTOP.cols
    pane.terminal.rows = DESKTOP.rows
  })
  return pane
}

async function connectPaneHoldingMobileFit(ptyId: string = PTY_ID): Promise<{
  pane: MockPane
  signalPty: ReturnType<typeof vi.fn>
  setFitOverride: typeof SetFitOverride
  setDriverForPty: typeof SetDriverForPty
  dispose: () => void
}> {
  const { connectPanePty } = await import('./pty-connection')
  // Why: vi.resetModules() gives every test a fresh module graph, so the override
  // emitter must be resolved from the same one connectPanePty subscribes to.
  const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
  const transport = createMockTransport(ptyId)
  transport.getPtyId.mockReturnValue(ptyId)
  transportFactoryQueue.push(transport)
  const pane = makeDesktopFittingPane(1)
  const manager = createManager(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, { isVisibleRef: { current: true } })
  const disposable = connectPanePty(pane as never, manager as never, deps as never)
  await flushAsyncTicks(6)

  // The phone takes the floor. Production order (handleMobileSubscribe): the
  // driver flips to mobile first, then the phone layout writes the hold.
  const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')
  setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
  setFitOverride(ptyId, 'mobile-fit', PHONE.cols, PHONE.rows)
  pane.terminal.cols = PHONE.cols
  pane.terminal.rows = PHONE.rows
  await flushAsyncTicks(2)

  const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
  signalPty.mockClear()
  return { pane, signalPty, setFitOverride, setDriverForPty, dispose: () => disposable.dispose() }
}

/** The phone already holds the grid before this pane mounts — an app reload
 *  hydrating overrides, or a tab reopened mid-hold. No mobile-fit event ever
 *  reaches this pane's listener, only the later desktop-fit release. */
async function connectPaneIntoExistingMobileFitHold(): Promise<{
  signalPty: ReturnType<typeof vi.fn>
  setFitOverride: typeof SetFitOverride
  setDriverForPty: typeof SetDriverForPty
  dispose: () => void
}> {
  const { connectPanePty } = await import('./pty-connection')
  const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
  const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')
  setDriverForPty(PTY_ID, { kind: 'mobile', clientId: 'phone-1' })
  setFitOverride(PTY_ID, 'mobile-fit', PHONE.cols, PHONE.rows)

  const transport = createMockTransport(PTY_ID)
  transport.getPtyId.mockReturnValue(PTY_ID)
  transportFactoryQueue.push(transport)
  const pane = makeDesktopFittingPane(1)
  pane.terminal.cols = PHONE.cols
  pane.terminal.rows = PHONE.rows
  const manager = createManager(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, { isVisibleRef: { current: true } })
  const disposable = connectPanePty(pane as never, manager as never, deps as never)
  await flushAsyncTicks(6)

  const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
  signalPty.mockClear()
  return { signalPty, setFitOverride, setDriverForPty, dispose: () => disposable.dispose() }
}

/** The desktop "Take back" gesture exactly as reclaimTerminalForDesktop's
 *  active-subscriber branch emits it: applyMobileDisplayMode publishes the
 *  desktop-fit release *while currentDriver is still mobile*, and only the
 *  following releaseDesktopTakeBack flips the driver. The order is awaited,
 *  not raced, and webContents.send preserves it across the two channels. */
async function takeBackFromPhone(
  setFitOverride: typeof SetFitOverride,
  setDriverForPty: typeof SetDriverForPty,
  ptyId: string = PTY_ID
): Promise<void> {
  setFitOverride(ptyId, 'desktop-fit', DESKTOP.cols, DESKTOP.rows)
  setDriverForPty(ptyId, { kind: 'desktop' })
  await flushAsyncTicks(6)
}

describe('mobile-fit release repaint', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('signals SIGWINCH once the restored desktop grid lands so the TUI repaints', async () => {
    const { pane, signalPty, setFitOverride, setDriverForPty, dispose } =
      await connectPaneHoldingMobileFit()
    // Why record inside the mock: asserting the final grid plus the call count
    // passes just as well when the signal fires *before* the refit, which is
    // the bug. Only the grid at signal time distinguishes the two.
    const gridAtSignal: { cols: number; rows: number }[] = []
    signalPty.mockImplementation(() => {
      gridAtSignal.push({ cols: pane.terminal.cols, rows: pane.terminal.rows })
    })

    await takeBackFromPhone(setFitOverride, setDriverForPty)

    expect({ signals: signalPty.mock.calls, gridAtSignal }).toEqual({
      signals: [[PTY_ID, 'SIGWINCH']],
      gridAtSignal: [DESKTOP]
    })
    dispose()
  })

  it('repaints a take-back whose release lands before the driver flips to desktop', async () => {
    const { signalPty, setFitOverride, setDriverForPty, dispose } =
      await connectPaneHoldingMobileFit()
    // Pin the emission order the gesture actually produces: the release is
    // observed while the presence lock still reads mobile. Gating the repaint
    // on the lock (rather than on the hold it released) silently drops every
    // desktop "Take back" — the exact gesture #14321 is about.
    const signalsBeforeDriverFlip: unknown[][] = []
    setFitOverride(PTY_ID, 'desktop-fit', DESKTOP.cols, DESKTOP.rows)
    await flushAsyncTicks(6)
    signalsBeforeDriverFlip.push(...signalPty.mock.calls)
    setDriverForPty(PTY_ID, { kind: 'desktop' })
    await flushAsyncTicks(6)

    expect({ signalsBeforeDriverFlip, allSignals: signalPty.mock.calls }).toEqual({
      signalsBeforeDriverFlip: [[PTY_ID, 'SIGWINCH']],
      allSignals: [[PTY_ID, 'SIGWINCH']]
    })
    dispose()
  })

  it('does not repaint-signal when another desktop takes the grid instead', async () => {
    const { signalPty, setFitOverride, dispose } = await connectPaneHoldingMobileFit()

    setFitOverride(PTY_ID, 'remote-desktop-fit', 100, 30)
    await flushAsyncTicks(6)

    expect(signalPty.mock.calls).toEqual([])
    setFitOverride(PTY_ID, 'desktop-fit', DESKTOP.cols, DESKTOP.rows)
    dispose()
  })

  it('repaint-signals only the hold it released, not every desktop-fit', async () => {
    const { signalPty, setFitOverride, setDriverForPty, dispose } =
      await connectPaneHoldingMobileFit()

    await takeBackFromPhone(setFitOverride, setDriverForPty)
    // A pty exit re-emits desktop-fit for an id that holds nothing (0x0).
    setFitOverride(PTY_ID, 'desktop-fit', 0, 0)
    await flushAsyncTicks(6)

    expect(signalPty.mock.calls).toEqual([[PTY_ID, 'SIGWINCH']])
    dispose()
  })

  it('does not repaint-signal a remote runtime pty, which has no signal channel', async () => {
    const remotePtyId = 'remote:env-1@@terminal-1'
    const { signalPty, setFitOverride, dispose } = await connectPaneHoldingMobileFit(remotePtyId)

    setFitOverride(remotePtyId, 'desktop-fit', DESKTOP.cols, DESKTOP.rows)
    await flushAsyncTicks(6)

    expect(signalPty.mock.calls).toEqual([])
    dispose()
  })

  it('repaints a pane that connected while the phone already held the grid', async () => {
    const { signalPty, setFitOverride, setDriverForPty, dispose } =
      await connectPaneIntoExistingMobileFitHold()

    await takeBackFromPhone(setFitOverride, setDriverForPty)

    expect(signalPty.mock.calls).toEqual([[PTY_ID, 'SIGWINCH']])
    dispose()
  })

  it('does not repaint when the hold is cleared without a paired resize', async () => {
    const { signalPty, setFitOverride, dispose } = await connectPaneHoldingMobileFit()

    // A pty exit, or a take-back whose best-effort resize never converged,
    // clears the hold with a 0x0 marker. The PTY may still be at phone dims.
    setFitOverride(PTY_ID, 'desktop-fit', 0, 0)
    await flushAsyncTicks(6)

    expect(signalPty.mock.calls).toEqual([])
    dispose()
  })

  // Why not "the driver still reads mobile": that is true of every take-back at
  // release time, so it cannot be the discriminator. The hold itself is — the
  // phone owns the grid only while an override is held.
  it('drops a parked repaint once the phone has retaken the grid', async () => {
    const { pane, signalPty, setFitOverride, setDriverForPty, dispose } =
      await connectPaneHoldingMobileFit()
    // The pane cannot measure yet (tab mid-layout), so the release parks the
    // refit for retry instead of running it.
    pane.fitAddon.proposeDimensions.mockReturnValue(undefined as never)
    vi.useFakeTimers()
    await takeBackFromPhone(setFitOverride, setDriverForPty)
    const signalsWhileParked = [...signalPty.mock.calls]

    // The phone takes the floor again before the pane measures, so the PTY is
    // back at phone dims. Replaying the parked repaint would redraw there.
    setDriverForPty(PTY_ID, { kind: 'mobile', clientId: 'phone-2' })
    setFitOverride(PTY_ID, 'mobile-fit', PHONE.cols, PHONE.rows)
    pane.fitAddon.proposeDimensions.mockReturnValue(DESKTOP)
    await vi.advanceTimersByTimeAsync(200)
    vi.useRealTimers()

    expect({ signalsWhileParked, allSignals: signalPty.mock.calls }).toEqual({
      signalsWhileParked: [],
      allSignals: []
    })
    setDriverForPty(PTY_ID, { kind: 'desktop' })
    dispose()
  })

  it('replays a parked repaint when the phone did not retake the grid', async () => {
    const { pane, signalPty, setFitOverride, setDriverForPty, dispose } =
      await connectPaneHoldingMobileFit()
    pane.fitAddon.proposeDimensions.mockReturnValue(undefined as never)
    vi.useFakeTimers()
    await takeBackFromPhone(setFitOverride, setDriverForPty)
    const signalsWhileParked = [...signalPty.mock.calls]

    pane.fitAddon.proposeDimensions.mockReturnValue(DESKTOP)
    await vi.advanceTimersByTimeAsync(200)
    vi.useRealTimers()

    expect({ signalsWhileParked, allSignals: signalPty.mock.calls }).toEqual({
      signalsWhileParked: [],
      allSignals: [[PTY_ID, 'SIGWINCH']]
    })
    dispose()
  })
})

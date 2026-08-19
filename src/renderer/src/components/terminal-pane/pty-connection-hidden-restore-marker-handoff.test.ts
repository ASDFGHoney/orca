import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps, type PaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

// STA-4869 route R6 — the renderer channel has no latch of its own:
// dispatchPtyModelRestoreNeeded (pty-model-restore-channel.ts) drops a marker
// for which no handler is registered. A pane that releases the last hidden claim
// while retiring unhides after unregistering its handler, so a drop latch
// consumed by unmark would be spent on a marker nobody can receive. The fix
// keeps the latch armed across unhide and retires it where recovery actually
// takes delivery of the bytes — main serving a model snapshot.
//
// This suite drives the REAL renderer channel from behind the
// setHiddenRendererPty IPC, delivering main's marker one turn later the way
// Electron does. Main's gate is modelled by mainDropLatch below rather than
// imported — src/main is outside the renderer tsconfig project — and its two
// rules are pinned against the real module in
// src/main/ipc/pty-hidden-delivery-gate.test.ts.

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
let createdTransportOptions: Record<string, unknown>[] = []
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
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

vi.mock('./pty-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEagerPtyBufferHandle: vi.fn(() => undefined)
}))

const PTY_ID = 'pty-id'
const BANNER_FRAGMENT = 'main recovery was unavailable'
const R6_MARKER = 'R6-LOST-c5e2'
const HIDDEN_CHUNK = 'hidden-agent-output\r\n'

type PaneDrive = {
  pane: MockPane
  deps: PaneConnectionDeps
  binding: { syncProcessTracking: () => void; dispose: () => void }
  deliver: (data: string, seq: number) => void
  setVisible: (visible: boolean) => void
  writtenChunks: () => string[]
}

/** Main's droppedSinceHiddenPtys latch (pty-hidden-delivery-gate.ts): the first
 *  gated drop arms it, neither re-marking hidden nor unmarking clears it, and
 *  only a served model snapshot (or teardown) retires it. */
const mainDropLatch = {
  hidden: false,
  dropped: false,
  markHidden(): void {
    this.hidden = true
  },
  /** @returns whether main owes the renderer a restore marker. */
  recordDrop(): boolean {
    if (this.dropped) {
      return false
    }
    this.dropped = true
    return true
  },
  /** @returns droppedWhileHidden — read, not spent. */
  unmarkHidden(): boolean {
    this.hidden = false
    return this.dropped
  },
  /** consumeHiddenRendererPtyDropMemory: recovery has the bytes now. */
  consumeDropMemory(): void {
    this.dropped = false
  },
  reset(): void {
    this.hidden = false
    this.dropped = false
  }
}

/** Routes the renderer's hidden-state IPC into main's real gate and delivers
 *  main's marker back one turn later, as the IPC round trip does. */
async function wireMainGateToRendererChannel(): Promise<{ markersDelivered: () => number }> {
  const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
  let markersDelivered = 0
  vi.mocked(window.api.pty.setHiddenRendererPty).mockImplementation(
    (id: string, hidden: boolean) => {
      if (hidden) {
        mainDropLatch.markHidden()
        return
      }
      if (!mainDropLatch.unmarkHidden()) {
        return
      }
      markersDelivered += 1
      queueMicrotask(() => {
        _dispatchPtyModelRestoreNeededForTest({ id, reason: 'unhide', markerSeq: 4096 })
      })
    }
  )
  return { markersDelivered: () => markersDelivered }
}

/** Main ingests the chunk into its model and drops the renderer copy. */
async function dropHiddenBytesInMain(): Promise<void> {
  const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
  expect(mainDropLatch.hidden).toBe(true)
  if (mainDropLatch.recordDrop()) {
    _dispatchPtyModelRestoreNeededForTest({ id: PTY_ID, reason: 'hidden-drop', markerSeq: 2048 })
  }
  await flushAsyncTicks(6)
}

async function connectPane(visible: boolean): Promise<PaneDrive> {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport(PTY_ID)
  const captured: {
    current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
  } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    captured.current = callbacks?.onData ?? null
    return PTY_ID
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef: { current: visible }
  })
  const binding = connectPanePty(pane as never, createManager(1) as never, deps as never) as {
    syncProcessTracking: () => void
    dispose: () => void
  }
  await flushAsyncTicks(6)
  expect(captured.current).not.toBeNull()
  return {
    pane,
    deps,
    binding,
    deliver: (data, seq) => captured.current?.(data, { seq, rawLength: data.length }),
    setVisible: (nextVisible) => {
      ;(deps.isVisibleRef as { current: boolean }).current = nextVisible
    },
    writtenChunks: () => pane.terminal.write.mock.calls.map(([data]) => String(data))
  }
}

function observeDisclosure(drive: PaneDrive): {
  bannerWrites: number
  markerWrites: number
  disclosedOrRecovered: boolean
} {
  const written = drive.writtenChunks()
  const bannerWrites = written.filter((data) => data.includes(BANNER_FRAGMENT)).length
  const markerWrites = written.join('').split(R6_MARKER).length - 1
  return {
    bannerWrites,
    markerWrites,
    disclosedOrRecovered: bannerWrites > 0 || markerWrites === 1
  }
}

describe('hidden-output restore marker handoff (STA-4869 R6)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mainDropLatch.reset()
    mockStoreState = createInitialStoreState(() => mockStoreState)
    mockStoreState.settings = {
      ...mockStoreState.settings,
      terminalMainSideEffectAuthority: true
    } as StoreState['settings']
    installTerminalTestGlobals()
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockImplementation(
      async (_id: string, opts?: { hiddenOutputRestore?: boolean }) => {
        // Main retires the drop latch when it actually serves recovery its bytes.
        if (opts?.hiddenOutputRestore === true) {
          mainDropLatch.consumeDropMemory()
        }
        return { data: `${R6_MARKER}\r\n`, cols: 120, rows: 40, seq: 4096 } as never
      }
    )
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
    const { _resetPtyRendererDeliveryClaimsForTest } =
      await import('./pty-renderer-delivery-claims')
    _resetPtyRendererDeliveryClaimsForTest()
  })

  it('[mechanism] the renderer channel drops a marker with no registered handler and never replays it', async () => {
    const { registerPtyModelRestoreNeededHandler, _dispatchPtyModelRestoreNeededForTest } =
      await import('./pty-model-restore-channel')
    const retiringHandler = vi.fn()
    const unregister = registerPtyModelRestoreNeededHandler(PTY_ID, retiringHandler)
    unregister()

    _dispatchPtyModelRestoreNeededForTest({ id: PTY_ID, reason: 'unhide', markerSeq: 4096 })
    expect(retiringHandler).not.toHaveBeenCalled()

    // The replacement view registers a moment later: nothing is held for it.
    const replacementHandler = vi.fn()
    registerPtyModelRestoreNeededHandler(PTY_ID, replacementHandler)
    await flushAsyncTicks(6)
    expect(replacementHandler).not.toHaveBeenCalled()
  })

  it('[control] a revealed pane consumes the unhide marker and repaints from the model', async () => {
    const gate = await wireMainGateToRendererChannel()
    const drive = await connectPane(false)
    drive.deliver(HIDDEN_CHUNK, HIDDEN_CHUNK.length)
    await dropHiddenBytesInMain()

    drive.setVisible(true)
    drive.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    expect(gate.markersDelivered()).toBe(1)
    expect(observeDisclosure(drive)).toMatchObject({ markerWrites: 1 })
    drive.binding.dispose()
  })

  it('[invariant] a hidden pane that retires must not spend the drop latch on a marker nobody receives', async () => {
    const gate = await wireMainGateToRendererChannel()
    const retiring = await connectPane(false)
    retiring.deliver(HIDDEN_CHUNK, HIDDEN_CHUNK.length)
    await dropHiddenBytesInMain()
    expect(vi.mocked(window.api.pty.setHiddenRendererPty)).toHaveBeenCalledWith(PTY_ID, true)

    // The pane retires (tab remount / recovery): releasing the last hidden claim
    // unhides the PTY in main, which answers with the one restore marker.
    retiring.binding.dispose()
    await flushAsyncTicks(20)
    expect(gate.markersDelivered()).toBe(1)

    // The replacement pane binds the same PTY while visible.
    const replacement = await connectPane(true)
    replacement.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    // Main still holds the dropped bytes and answers any snapshot request with
    // them, so the replacement pane owes the user either those bytes or a banner.
    const disclosure = {
      ...observeDisclosure(replacement),
      modelSnapshotRequests: vi.mocked(window.api.pty.getMainBufferSnapshot).mock.calls.length
    }
    expect(
      disclosure.disclosedOrRecovered,
      `hidden output was neither reconciled nor disclosed after remount: ${JSON.stringify(disclosure)}`
    ).toBe(true)
    replacement.binding.dispose()
  })

  it('[fix] the remount re-emits the unhide marker and one snapshot retires the latch', async () => {
    const gate = await wireMainGateToRendererChannel()
    const retiring = await connectPane(false)
    retiring.deliver(HIDDEN_CHUNK, HIDDEN_CHUNK.length)
    await dropHiddenBytesInMain()
    retiring.binding.dispose()
    await flushAsyncTicks(20)
    expect(gate.markersDelivered()).toBe(1)

    const replacement = await connectPane(true)
    replacement.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    // The latch outlived the marker nobody received, so the remount's own unhide
    // re-emits it; the snapshot that heals the gap is what finally spends it.
    expect(gate.markersDelivered()).toBe(2)
    expect(observeDisclosure(replacement)).toMatchObject({ markerWrites: 1 })
    expect(mainDropLatch.dropped).toBe(false)

    // No marker storm: hide/reveal cycles after consumption ask for nothing.
    const snapshotRequests = vi.mocked(window.api.pty.getMainBufferSnapshot).mock.calls.length
    replacement.setVisible(false)
    replacement.binding.syncProcessTracking()
    replacement.setVisible(true)
    replacement.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    expect(gate.markersDelivered()).toBe(2)
    expect(vi.mocked(window.api.pty.getMainBufferSnapshot).mock.calls.length).toBe(snapshotRequests)
    replacement.binding.dispose()
  })
})

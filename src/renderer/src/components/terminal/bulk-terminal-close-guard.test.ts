import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, inspectRuntimeTerminalProcessMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'
import { collectBulkTerminalTabIds, guardBulkTerminalClose } from './bulk-terminal-close-guard'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function setState(overrides: Record<string, unknown> = {}): void {
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'] },
    terminalLayoutsByTabId: {
      'tab-a': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } },
      'tab-b': { ptyIdsByLeafId: { [LEAF_B]: 'pty-b' } }
    },
    unifiedTabsByWorktree: {
      'wt-1': [
        { id: 'unified-a', entityId: 'tab-a', contentType: 'terminal', label: 'npm run dev' },
        { id: 'unified-b', entityId: 'tab-b', contentType: 'terminal', label: 'pytest' }
      ]
    },
    tabsByWorktree: { 'wt-1': [{ id: 'tab-a' }, { id: 'tab-b' }] },
    agentStatusByPaneKey: {},
    ...overrides
  })
}

function guard(onProceed = vi.fn(), onCancel?: () => void): void {
  guardBulkTerminalClose({
    worktreeId: 'wt-1',
    terminalTabIds: ['tab-a', 'tab-b'],
    onProceed,
    ...(onCancel ? { onCancel } : {})
  })
}

function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('collectBulkTerminalTabIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setState()
  })

  it('accepts unified ids and entity ids, and skips non-terminal and pinned tabs', () => {
    setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          { id: 'unified-a', entityId: 'tab-a', contentType: 'terminal' },
          { id: 'unified-b', entityId: 'tab-b', contentType: 'terminal', isPinned: true },
          { id: 'unified-c', entityId: 'file-c', contentType: 'editor' }
        ]
      }
    })

    expect(
      collectBulkTerminalTabIds(getStateMock(), 'wt-1', ['unified-a', 'tab-b', 'unified-c'])
    ).toEqual(['tab-a'])
  })

  it('falls back to the runtime tab store for a terminal with no unified row yet', () => {
    setState({ unifiedTabsByWorktree: { 'wt-1': [] } })

    expect(collectBulkTerminalTabIds(getStateMock(), 'wt-1', ['tab-a', 'unknown'])).toEqual([
      'tab-a'
    ])
  })
})

describe('guardBulkTerminalClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setState()
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: false,
      unavailable: false
    })
    useRunningTerminalCloseConfirmStore.setState({ runningTerminalCloseConfirm: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('proceeds synchronously when no tab in the set has a live pty', () => {
    setState({ ptyIdsByTabId: {}, terminalLayoutsByTabId: {} })
    const onProceed = vi.fn()

    guard(onProceed)

    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
    expect(visibleRequest()).toBeNull()
  })

  it('proceeds synchronously when the user opted out of the prompt', () => {
    setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        skipCloseTerminalWithRunningProcessConfirm: true
      }
    })
    const onProceed = vi.fn()

    guard(onProceed)

    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
  })

  it('proceeds without asking when every probe reports an idle shell', async () => {
    const onProceed = vi.fn()

    guard(onProceed)
    await settleProbe()

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledTimes(2)
    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('raises one aggregated prompt naming every busy tab', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })
    const onProceed = vi.fn()

    guard(onProceed)
    await settleProbe()

    expect(onProceed).not.toHaveBeenCalled()
    const request = visibleRequest()
    expect(request?.busyTabLabels).toEqual(['npm run dev', 'pytest'])
    expect(request?.terminalTabId).toBe('bulk:tab-a,tab-b')
    expect(request?.copyKind).toBe('command')

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(onProceed).toHaveBeenCalledTimes(1)
  })

  it('lists only the busy tabs, keeping strip order', async () => {
    inspectRuntimeTerminalProcessMock.mockImplementation((_settings, ptyId: string) =>
      Promise.resolve({ hasChildProcesses: ptyId === 'pty-b', unavailable: false })
    )

    guard()
    await settleProbe()

    const request = visibleRequest()
    expect(request?.busyTabLabels).toEqual(['pytest'])
    // Why: a lone busy tab keys on its real id so it merges with that tab's own prompt.
    expect(request?.terminalTabId).toBe('tab-b')
  })

  it('cancelling abandons the whole bulk close', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })
    const onProceed = vi.fn()
    const onCancel = vi.fn()

    guard(onProceed, onCancel)
    await settleProbe()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()

    expect(onProceed).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('words the prompt for agents when any busy pane is one', async () => {
    setState({
      agentStatusByPaneKey: { [`tab-b:${LEAF_B}`]: { agentType: 'claude' } }
    })
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })

    guard()
    await settleProbe()

    expect(visibleRequest()?.copyKind).toBe('agent')
  })

  it('proceeds on an answered probe that could not inspect the shell', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: true
    })
    const onProceed = vi.fn()

    guard(onProceed)
    await settleProbe()

    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })

  it('asks rather than closes when the probe never answers', async () => {
    vi.useFakeTimers()
    inspectRuntimeTerminalProcessMock.mockReturnValue(new Promise(() => {}))
    const onProceed = vi.fn()

    guard(onProceed)
    vi.advanceTimersByTime(RUNNING_CLOSE_PROBE_TIMEOUT_MS)

    expect(onProceed).not.toHaveBeenCalled()
    expect(visibleRequest()?.busyTabLabels).toEqual(['npm run dev', 'pytest'])
  })

  it('merges a repeated bulk close into the open prompt instead of stacking one', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })
    const first = vi.fn()
    const second = vi.fn()

    guard(first)
    await settleProbe()
    guard(second)
    await settleProbe()

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(visibleRequest()).toBeNull()
  })
})

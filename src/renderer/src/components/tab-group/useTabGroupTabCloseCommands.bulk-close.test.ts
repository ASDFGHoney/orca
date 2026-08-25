import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  closeBrowserTab: vi.fn(),
  closeFile: vi.fn(),
  closeTab: vi.fn(),
  closeTerminalTab: vi.fn(),
  closeUnifiedTab: vi.fn(),
  inspectRuntimeTerminalProcess: vi.fn(),
  setActiveWorktree: vi.fn()
}))

const storeBox = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, useCallback: <T>(callback: T) => callback }
})

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeBox.state),
    { getState: () => storeBox.state }
  )
  return { useAppStore }
})

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: mocks.inspectRuntimeTerminalProcess
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: () => false
}))

vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: vi.fn()
}))

vi.mock('../editor/editor-autosave', () => ({ requestEditorFileClose: vi.fn() }))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/runtime/remote-browser-tab-ownership', () => ({
  browserWorkspaceHasRemoteOwner: () => false
}))

vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: mocks.closeTerminalTab }))

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'

const GROUP_TABS = [
  { id: 'unified-a', entityId: 'tab-a', contentType: 'terminal', label: 'npm run dev' },
  { id: 'unified-b', entityId: 'tab-b', contentType: 'terminal', label: 'pytest' }
] as unknown as Tab[]

// Why: `useCallback` is stubbed to identity above, so the hook is a plain factory here.
function useCloseCommands() {
  return useTabGroupTabCloseCommands({ worktreeId: 'wt-1', groupTabs: GROUP_TABS })
}

async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useTabGroupTabCloseCommands closeMany', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeBox.state = {
      settings: {},
      ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'] },
      terminalLayoutsByTabId: {},
      unifiedTabsByWorktree: { 'wt-1': GROUP_TABS },
      tabsByWorktree: { 'wt-1': [{ id: 'tab-a' }, { id: 'tab-b' }] },
      openFiles: [],
      browserPagesByWorkspace: {},
      agentStatusByPaneKey: {},
      activeWorktreeId: 'wt-1',
      closeUnifiedTab: mocks.closeUnifiedTab,
      closeTab: mocks.closeTab,
      closeFile: mocks.closeFile,
      closeBrowserTab: mocks.closeBrowserTab,
      setActiveWorktree: mocks.setActiveWorktree,
      reconcileWorktreeTabModel: () => ({ renderableTabCount: 1 })
    }
    useRunningTerminalCloseConfirmStore.setState({ runningTerminalCloseConfirm: null })
  })

  it('closes straight through when no tab in the set is busy', async () => {
    mocks.inspectRuntimeTerminalProcess.mockResolvedValue({
      hasChildProcesses: false,
      unavailable: false
    })

    useCloseCommands().closeMany(['unified-a', 'unified-b'])
    await settleProbe()

    expect(mocks.closeTab).toHaveBeenCalledTimes(2)
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
  })

  it('holds every close behind one prompt when tabs are busy, then runs them on confirm', async () => {
    mocks.inspectRuntimeTerminalProcess.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })

    useCloseCommands().closeMany(['unified-a', 'unified-b'])
    await settleProbe()

    expect(mocks.closeTab).not.toHaveBeenCalled()
    const request = useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
    expect(request?.busyTabLabels).toEqual(['npm run dev', 'pytest'])

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(mocks.closeTab).toHaveBeenCalledTimes(2)
  })

  it('closes nothing when the prompt is cancelled', async () => {
    mocks.inspectRuntimeTerminalProcess.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })

    useCloseCommands().closeMany(['unified-a', 'unified-b'])
    await settleProbe()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()

    expect(mocks.closeTab).not.toHaveBeenCalled()
  })
})

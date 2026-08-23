import { beforeEach, describe, expect, it, vi } from 'vitest'

const queueTabStartupCommand = vi.fn()
const localWorktree = {
  id: 'shared-worktree',
  repoId: 'repo-1',
  path: '/local/worktree',
  hostId: 'local' as const
}
const sshWorktree = {
  id: 'shared-worktree',
  repoId: 'repo-1',
  path: '/remote/worktree',
  hostId: 'ssh:ssh-a' as const
}
const store = {
  activeRepoId: null,
  activeWorktreeId: 'folder:folder-1',
  activeWorkspaceExecutionHostId: 'ssh:ssh-a' as string | null,
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null
  },
  projects: [],
  repos: [
    { id: 'repo-1', path: '/local', connectionId: null, executionHostId: 'local' },
    { id: 'repo-1', path: '/remote', connectionId: 'ssh-a', executionHostId: 'ssh:ssh-a' }
  ],
  folderWorkspaces: [
    {
      id: 'folder-1',
      projectGroupId: 'group-1',
      folderPath: '/local/folder',
      connectionId: null,
      executionHostId: 'local'
    },
    {
      id: 'folder-1',
      projectGroupId: 'group-1',
      folderPath: '/remote/folder',
      connectionId: 'ssh-a'
    }
  ],
  projectGroups: [
    { id: 'group-1', parentGroupId: null, connectionId: null, executionHostId: 'local' },
    {
      id: 'group-1',
      parentGroupId: null,
      connectionId: 'ssh-a',
      executionHostId: 'ssh:ssh-a'
    }
  ],
  worktreesByRepo: { 'repo-1': [localWorktree, sshWorktree] },
  detectedWorktreesByRepo: {},
  sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]]),
  transientClearedAgentStatusConnectionIds: {},
  tabsByWorktree: { 'folder:folder-1': [] },
  openFiles: [],
  browserTabsByWorktree: {},
  tabBarOrderByWorktree: {},
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  getKnownWorktreeById: vi.fn((worktreeId: string, executionHostId?: string) => {
    if (worktreeId === 'folder:folder-1' && executionHostId === 'ssh:ssh-a') {
      return {
        id: 'folder:folder-1',
        repoId: 'folder-workspace:group-1',
        path: '/remote/folder'
      }
    }
    if (worktreeId === 'shared-worktree') {
      return executionHostId === 'ssh:ssh-a' ? sshWorktree : localWorktree
    }
    return undefined
  }),
  allWorktrees: vi.fn(() => []),
  createTab: vi.fn(() => ({ id: 'tab-folder' })),
  closeTab: vi.fn(),
  queueTabStartupCommand,
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

describe('launchAgentInNewTab SSH folder ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.activeWorktreeId = 'folder:folder-1'
    store.activeWorkspaceExecutionHostId = 'ssh:ssh-a'
  })

  it('wraps Codex from New Tab in an existing folder workspace', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'folder:folder-1' })

    expect(queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-folder',
      expect.objectContaining({
        command: expect.stringContaining('codex'),
        startupCommandDelivery: 'shell-ready'
      })
    )
  })

  it('qualifies colliding worktree IDs with the active SSH host', async () => {
    store.activeWorktreeId = 'shared-worktree'
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'shared-worktree' })

    expect(store.getKnownWorktreeById).toHaveBeenCalledWith('shared-worktree', 'ssh:ssh-a')
    expect(queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-folder',
      expect.objectContaining({
        command: expect.stringContaining('codex'),
        startupCommandDelivery: 'shell-ready'
      })
    )
  })

  it('fails closed when colliding worktree ownership has no active host', async () => {
    store.activeWorktreeId = 'other-worktree'
    store.activeWorkspaceExecutionHostId = null
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    expect(() => launchAgentInNewTab({ agent: 'codex', worktreeId: 'shared-worktree' })).toThrow(
      'unavailable or ambiguous'
    )
    expect(store.createTab).not.toHaveBeenCalled()
    expect(queueTabStartupCommand).not.toHaveBeenCalled()
  })
})

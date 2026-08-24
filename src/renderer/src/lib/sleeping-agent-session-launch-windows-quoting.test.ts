// Windows shell-quoting coverage for the sleeping-agent resume launch (#12320):
// the queued resume line is typed into the new tab's shell, so cmd.exe tabs must
// not receive PowerShell single quotes.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()

const store = {
  activeWorktreeId: 'wt-1',
  activeWorkspaceExecutionHostId: 'local' as string | null,
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  } as {
    agentCmdOverrides: Record<string, string>
    agentDefaultArgs: Record<string, string>
    agentDefaultEnv: Record<string, Record<string, string>>
    activeRuntimeEnvironmentId: string | null
    terminalWindowsShell?: string
  },
  repos: [
    {
      id: 'repo-1',
      connectionId: null as string | null,
      path: 'C:\\Users\\neil\\repo',
      executionHostId: 'local'
    }
  ] as { id: string; connectionId: string | null; path: string; executionHostId: string }[],
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        path: 'C:\\Users\\neil\\repo\\feature',
        displayName: 'feature',
        hostId: 'local'
      }
    ]
  } as Record<
    string,
    { id: string; repoId: string; path: string; displayName: string; hostId: string }[]
  >,
  getKnownWorktreeById: vi.fn((id: string, executionHostId?: string) =>
    Object.values(store.worktreesByRepo)
      .flat()
      .find(
        (worktree) =>
          worktree.id === id && (!executionHostId || worktree.hostId === executionHostId)
      )
  ),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  queueTabStartupCommand: mockQueueTabStartupCommand,
  claimAutomaticAgentResume: vi.fn(),
  clearSleepingAgentSession: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn((_stored, termIds: string[]) => [...termIds])
}))

const SESSION_ID = '0199f7a1-0000-7000-8000-000000000001'

const record: SleepingAgentSessionRecord = {
  paneKey: 'tab-1::leaf-1',
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  agent: 'codex',
  providerSession: { key: 'session_id', id: SESSION_ID },
  prompt: 'finish the task',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1
}

async function launch(): Promise<{ command: string; startupCommandDelivery?: string } | undefined> {
  const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
  launchSleepingAgentSession(record)
  const queued = mockQueueTabStartupCommand.mock.calls.at(-1)?.[1] as
    | { command: string; startupCommandDelivery?: string }
    | undefined
  return queued
}

describe('launchSleepingAgentSession Windows shell quoting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null
    }
    store.activeWorktreeId = 'wt-1'
    store.activeWorkspaceExecutionHostId = 'local'
    store.repos = [
      {
        id: 'repo-1',
        connectionId: null,
        path: 'C:\\Users\\neil\\repo',
        executionHostId: 'local'
      }
    ]
    store.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: 'C:\\Users\\neil\\repo\\feature',
          displayName: 'feature',
          hostId: 'local'
        }
      ]
    }
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  it('skips a resume while the worktree owner is unavailable', async () => {
    const repos = store.repos
    store.repos = []
    try {
      const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
      expect(launchSleepingAgentSession(record)).toBe(false)
      expect(mockCreateTab).not.toHaveBeenCalled()
    } finally {
      store.repos = repos
    }
  })

  it('quotes the resume argv for a cmd.exe tab', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'

    await expect(launch()).resolves.toMatchObject({
      command: `codex "--dangerously-bypass-approvals-and-sandbox" "resume" "${SESSION_ID}"`
    })
  })

  it('keeps PowerShell quoting for a powershell tab', async () => {
    store.settings.terminalWindowsShell = 'powershell.exe'

    await expect(launch()).resolves.toMatchObject({
      command: `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${SESSION_ID}'`
    })
  })

  it('quotes the resume argv for a Git Bash tab', async () => {
    store.settings.terminalWindowsShell = 'git-bash'

    await expect(launch()).resolves.toMatchObject({
      command: `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${SESSION_ID}'`
    })
  })

  it('keeps a colliding SSH owner authoritative on a Windows client', async () => {
    store.settings.terminalWindowsShell = 'cmd.exe'
    store.activeWorkspaceExecutionHostId = 'ssh:ssh-1'
    store.repos = [
      {
        id: 'repo-1',
        connectionId: null,
        path: 'C:\\Users\\neil\\repo',
        executionHostId: 'local'
      },
      {
        id: 'repo-1',
        connectionId: 'ssh-1',
        path: '/home/neil/repo',
        executionHostId: 'ssh:ssh-1'
      }
    ]
    store.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: 'C:\\Users\\neil\\repo\\feature',
          displayName: 'feature',
          hostId: 'local'
        },
        {
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/home/neil/repo/feature',
          displayName: 'feature',
          hostId: 'ssh:ssh-1'
        }
      ]
    }

    await expect(launch()).resolves.toMatchObject({
      command: `codex '--dangerously-bypass-approvals-and-sandbox' 'resume' '${SESSION_ID}'`,
      startupCommandDelivery: 'shell-ready'
    })
    expect(store.getKnownWorktreeById).toHaveBeenCalledWith('wt-1', 'ssh:ssh-1')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual }
})

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    pickFolder: vi.fn().mockResolvedValue(null)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined)
  },
  settings: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined)
  }
}

// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import { createTestStore, makeWorktree, makeTab, makeLayout } from './store-test-helpers'
import { createClosedResourceSessionCountSelector } from '../../components/status-bar/resource-session-count-selector'

const WT = 'repo1::/path/wt1'
const DEAD_PTY = `${WT}@@dead`
const LIVE_PTY = `${WT}@@live`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('closed badge liveness across exits and restarts (#8372)', () => {
  it('stops counting a claimed session once its exit is recorded, and counts it again on wake', () => {
    const store = createTestStore()
    const selectCount = createClosedResourceSessionCountSelector()
    store.setState({
      workspaceSessionReady: true,
      tabsByWorktree: {
        [WT]: [
          makeTab({ id: 'tab1', worktreeId: WT, ptyId: DEAD_PTY }),
          makeTab({ id: 'tab2', worktreeId: WT, ptyId: LIVE_PTY })
        ]
      },
      ptyIdsByTabId: { tab1: [DEAD_PTY], tab2: [LIVE_PTY] }
    })

    expect(selectCount(store.getState())).toBe(2)

    // The daemon session behind tab1 exits while the tab is not mounted:
    // claims survive (they key cold-restore), the badge stops counting.
    store.getState().markPtySessionsExited([DEAD_PTY])
    expect(store.getState().tabsByWorktree[WT][0].ptyId).toBe(DEAD_PTY)
    expect(store.getState().ptyIdsByTabId.tab1).toEqual([DEAD_PTY])
    expect(selectCount(store.getState())).toBe(1)

    // Wake: a mounted pane re-registers the same session id — alive again.
    store.getState().updateTabPtyId('tab1', DEAD_PTY)
    expect(store.getState().deadPtyIds).toEqual({})
    expect(selectCount(store.getState())).toBe(2)
  })

  it('ignores exits for unclaimed sessions and reports no store write', () => {
    const store = createTestStore()
    store.setState({ workspaceSessionReady: true })
    const before = store.getState().deadPtyIds
    store.getState().markPtySessionsExited(['repo1::/elsewhere@@gone'])
    expect(store.getState().deadPtyIds).toBe(before)
  })

  it('keeps the badge honest across a restart: persisted dead ids survive hydration and reconnect', async () => {
    const store = createTestStore()
    const selectCount = createClosedResourceSessionCountSelector()
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: WT,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [WT]: [
          makeTab({ id: 'tab1', worktreeId: WT, ptyId: DEAD_PTY }),
          makeTab({ id: 'tab2', worktreeId: WT, ptyId: LIVE_PTY })
        ]
      },
      terminalLayoutsByTabId: { tab1: makeLayout(), tab2: makeLayout() },
      activeWorktreeIdsOnShutdown: [WT],
      deadPtyIds: [DEAD_PTY]
    })
    await store.getState().reconnectPersistedTerminals()

    const state = store.getState()
    // Reconnect restored both wake hints — the dead one included, because it
    // still keys daemon-side cold restore…
    expect(state.tabsByWorktree[WT].map((tab) => tab.ptyId)).toEqual([DEAD_PTY, LIVE_PTY])
    // …but the badge only counts the session that was alive at last save.
    expect(selectCount(state)).toBe(1)
  })
})

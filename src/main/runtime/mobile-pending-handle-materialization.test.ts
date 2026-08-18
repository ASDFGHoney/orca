/**
 * A terminal tab published as `pending-handle` is a promise that the host will
 * say something else later. Mobile bounds its pending-handle recovery polling to
 * 5 attempts ~2s apart (STA-4407), so a client that is told `pending-handle` and
 * never told otherwise stops asking after ~10s and strands the pane on the
 * spinner with no composer at all — no terminal keystrokes, no native chat
 * (STA-4256).
 *
 * The gap these pin: the tab is published before its PTY exists, so the snapshot
 * does not name the ptyId and `touchMobileSessionSnapshotsForPty` cannot find it.
 * PTY registration is the only moment that resolves it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'
// Why real UUIDs: registerPty only records tabId/paneKey when the leaf id is a
// stable pane id, and the pending tab is matched back by exactly that paneKey.
const TAB = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const LEAF = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const LATE_PTY = 'pty-late'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

function makeSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

/** A renderer snapshot naming a PTY that has not registered yet. */
function makeRendererSnapshot(version: number): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: 'renderer:test-epoch',
    snapshotVersion: version,
    activeGroupId: 'group-1',
    activeTabId: `${TAB}::${LEAF}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${TAB}::${LEAF}`,
        parentTabId: TAB,
        leafId: LEAF,
        title: 'Claude Code',
        ptyId: LATE_PTY,
        isActive: true
      }
    ]
  }
}

function createRuntime() {
  let session = makeSession()
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  })
  const events: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
  const sync = (mobileSessionTabs: RuntimeMobileSessionTabsSnapshot[]): void => {
    runtime.syncWindowGraph(1, { tabs: [] as never, leaves: [] as never, mobileSessionTabs })
  }
  return { runtime, events, sync }
}

/** Drives the tab to the published `pending-handle` state and returns that frame. */
function publishPendingHandleTab(): {
  runtime: OrcaRuntimeService
  events: RuntimeMobileSessionTabsResult[]
  pendingFrame: RuntimeMobileSessionTabsResult
} {
  const { runtime, events, sync } = createRuntime()
  sync([makeRendererSnapshot(1)])
  vi.advanceTimersByTime(300)
  const pendingFrame = events.at(-1)
  expect(pendingFrame?.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
  events.length = 0
  return { runtime, events, pendingFrame: pendingFrame! }
}

describe('mobile pending-handle materialization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pushes the materialized handle when the PTY registers with no further renderer sync', () => {
    const { runtime, events, pendingFrame } = publishPendingHandleTab()

    // The spawn completes. No graph sync, no renderer republication — this
    // registration is the whole event, exactly as it is for an agent tab the
    // renderer published before its PTY existed.
    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)

    const ready = events.at(-1)
    expect(ready?.tabs[0]).toMatchObject({
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
    // Why this assertion and not just "an event fired": clients gate mirrored
    // snapshots on a strictly increasing snapshotVersion within an epoch, so a
    // re-emit at the pending frame's version is dropped and the pane stays stuck.
    expect(ready?.publicationEpoch).toBe(pendingFrame.publicationEpoch)
    expect(ready!.snapshotVersion).toBeGreaterThan(pendingFrame.snapshotVersion)
  })

  // Not a repro of the bug — it passes against the pre-fix source by construction,
  // because pre-fix nothing ever pushes. It guards the fix against over-publishing.
  it('does not push for an unrelated worktree once nothing is pending', () => {
    const { runtime, events } = publishPendingHandleTab()

    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)
    events.length = 0

    // The debt is settled; a later spawn elsewhere must not keep republishing.
    runtime.registerPty('pty-unrelated', 'repo-1::/tmp/worktree-b', null)
    vi.advanceTimersByTime(300)

    expect(events).toEqual([])
  })
})

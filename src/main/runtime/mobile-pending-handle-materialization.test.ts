import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { OrcaRuntimeService } from './orca-runtime'

// Freshness predicate every mirrored client applies, copied as a literal because a
// main-process test must not import a renderer/mobile module: within one epoch a frame
// whose version is not strictly newer is dropped. An old client that predates the #14916
// poll bound still gates on exactly this, so a push it cannot accept is a push that never
// happened.
function makeClientFreshnessGate(): (frame: RuntimeMobileSessionTabsResult) => boolean {
  const latest = new Map<string, { publicationEpoch: string; snapshotVersion: number }>()
  return (frame) => {
    const current = latest.get(frame.worktree)
    if (
      current &&
      current.publicationEpoch === frame.publicationEpoch &&
      frame.snapshotVersion <= current.snapshotVersion
    ) {
      return false
    }
    latest.set(frame.worktree, {
      publicationEpoch: frame.publicationEpoch,
      snapshotVersion: frame.snapshotVersion
    })
    return true
  }
}

const WT = 'repo-1::/tmp/worktree-a'
const PARKED_WT = 'repo-1::/tmp/worktree-parked'
// Why: registration records pane identity only for stable tab and leaf IDs.
const TAB = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const LEAF = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const LATE_PTY = `${WT}@@late-pty`
const worktreeMeta: WorktreeMeta = {
  displayName: '',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

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
  updateRepo: () => storeBase.getRepo(),
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => worktreeMeta,
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

function makeRendererSnapshot(
  version: number,
  options: {
    worktree?: string
    tabId?: string
    leafId?: string
    ptyId?: string | null
  } = {}
): RuntimeMobileSessionTabsSnapshot {
  const worktree = options.worktree ?? WT
  const tabId = options.tabId ?? TAB
  const leafId = options.leafId ?? LEAF
  const ptyId = options.ptyId ?? null
  return {
    worktree,
    publicationEpoch: 'renderer:test-epoch',
    snapshotVersion: version,
    activeGroupId: 'group-1',
    activeTabId: `${tabId}::${leafId}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${tabId}::${leafId}`,
        parentTabId: tabId,
        leafId,
        title: 'Claude Code',
        ...(ptyId ? { ptyId } : {}),
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs })
  }
  return { runtime, events, sync }
}

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
  if (!pendingFrame) {
    throw new Error('expected pending frame')
  }
  events.length = 0
  return { runtime, events, pendingFrame }
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

    runtime.onPtySpawned(LATE_PTY)
    vi.advanceTimersByTime(300)
    expect(events).toEqual([])
    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)

    const ready = events.at(-1)
    expect(ready?.tabs[0]).toMatchObject({
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
    expect(ready?.publicationEpoch).toBe(pendingFrame.publicationEpoch)
    expect(ready?.snapshotVersion).toBeGreaterThan(pendingFrame.snapshotVersion)
  })

  it('does not push for an unrelated worktree once nothing is pending', () => {
    const { runtime, events } = publishPendingHandleTab()

    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)
    events.length = 0

    runtime.registerPty('pty-unrelated', 'repo-1::/tmp/worktree-b', null)
    vi.advanceTimersByTime(300)

    expect(events).toEqual([])
  })

  it('does not bump an already-addressable pane on duplicate registration', () => {
    const { runtime, events } = publishPendingHandleTab()
    runtime.onPtySpawned(LATE_PTY)
    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)
    events.length = 0
    const touch = vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree')

    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)

    expect(touch).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('does not push when the renderer published a different PTY identity', () => {
    const { runtime, events, sync } = createRuntime()
    sync([makeRendererSnapshot(1, { ptyId: 'stale-pty' })])
    vi.advanceTimersByTime(300)
    events.length = 0
    const touch = vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree')

    runtime.onPtySpawned(LATE_PTY)
    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)

    expect(touch).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('does not touch an unrelated parked pending pane when a PTY registers', () => {
    const { runtime, events, sync } = createRuntime()
    sync([
      makeRendererSnapshot(1),
      makeRendererSnapshot(1, {
        worktree: PARKED_WT,
        tabId: 'cccccccc-3333-4333-8333-cccccccccccc',
        leafId: 'dddddddd-4444-4444-8444-dddddddddddd',
        ptyId: 'pty-parked'
      })
    ])
    vi.advanceTimersByTime(300)
    events.length = 0
    const touch = vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree')

    runtime.onPtySpawned(LATE_PTY)
    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)

    expect(touch).toHaveBeenCalledTimes(1)
    expect(touch).toHaveBeenCalledWith(WT)
    expect(events.map((event) => event.worktree)).toEqual([WT])
  })

  // The client's recovery budget is 5 attempts ~2s apart (#14916). The host has no timer
  // and must not acquire one: these pin that the publication is driven by the addressability
  // transition, not by elapsed time, at each position relative to that budget.

  it('publishes ready with no materialization push when the PTY is addressable first', () => {
    const { runtime, events, sync } = createRuntime()
    // Registration BEFORE the tab is ever published: nothing was promised, so nothing is owed.
    runtime.onPtySpawned(LATE_PTY)
    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    const touch = vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree')

    sync([makeRendererSnapshot(1)])
    vi.advanceTimersByTime(300)

    expect(events.at(-1)?.tabs[0]).toMatchObject({
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
    expect(touch).not.toHaveBeenCalled()
  })

  it('pushes when the PTY registers inside the client recovery window', () => {
    const { runtime, events, pendingFrame } = publishPendingHandleTab()

    // ~4s in: the client is still polling and would also have found this itself.
    vi.advanceTimersByTime(4000)
    runtime.onPtySpawned(LATE_PTY)
    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)

    expect(events.at(-1)?.tabs[0]).toMatchObject({ status: 'ready' })
    expect(events.at(-1)?.snapshotVersion).toBeGreaterThan(pendingFrame.snapshotVersion)
  })

  it('pushes after the client recovery budget, past intervening republications', () => {
    const { runtime, events } = publishPendingHandleTab()
    const accepts = makeClientFreshnessGate()

    // 30s: well past the ~10s budget, so a parked client has stopped asking and the push is
    // the only thing that can repair it. Intervening churn (title/status) bumps the version
    // meanwhile, so the push must beat the NEWEST frame the client took, not the first one.
    for (let elapsed = 0; elapsed < 30_000; elapsed += 10_000) {
      runtime.touchMobileSessionTabsForWorktree(WT)
      vi.advanceTimersByTime(10_000)
    }
    for (const frame of events) {
      accepts(frame)
    }
    const lastAccepted = events.at(-1)
    expect(lastAccepted?.tabs[0]).toMatchObject({ status: 'pending-handle' })
    events.length = 0

    runtime.onPtySpawned(LATE_PTY)
    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)

    const ready = events.at(-1)
    expect(ready?.tabs[0]).toMatchObject({
      status: 'ready',
      terminal: expect.stringMatching(/^term_/)
    })
    expect(ready!.snapshotVersion).toBeGreaterThan(lastAccepted!.snapshotVersion)
    // Old-client compatibility: an unchanged same-epoch gate takes this frame.
    expect(accepts(ready!)).toBe(true)
  })

  it('pushes again when a reconnecting PTY makes the pane addressable a second time', () => {
    const { runtime } = publishPendingHandleTab()
    runtime.onPtySpawned(LATE_PTY)
    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)

    // Why: `paneWasAddressable` must not latch. A pane that dies and comes back is owed the
    // same publication as a pane that materialized once.
    runtime.onPtyExit(LATE_PTY, 0)
    vi.advanceTimersByTime(300)
    const touch = vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree')

    runtime.registerPty(LATE_PTY, WT, null, { tabId: TAB, leafId: LEAF })
    vi.advanceTimersByTime(300)

    expect(touch).toHaveBeenCalledWith(WT)
  })

  it('does not retain deleted pending worktrees in the registration path', () => {
    const { runtime, events, sync } = createRuntime()
    sync([makeRendererSnapshot(1)])
    vi.advanceTimersByTime(300)
    sync([])
    vi.advanceTimersByTime(300)
    events.length = 0
    const touch = vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree')

    runtime.registerPty('pty-unrelated', 'repo-1::/tmp/worktree-b', null)
    vi.advanceTimersByTime(300)

    expect(touch).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })
})

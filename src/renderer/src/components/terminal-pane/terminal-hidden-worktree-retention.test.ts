import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { TERMINAL_WORKTREE_PARK_DELAY_MS } from './terminal-hidden-view-parking'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'
import {
  TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS,
  createTerminalWorktreeTopologyProjection,
  hasPendingRetentionSpawnWork,
  isEvictionExemptTerminalPty,
  selectForceParkEvictableTabIds,
  countMountedWorktreePanes,
  selectRetentionForceParkedTerminalWorktrees,
  type TerminalWorktreeRetentionCandidate
} from './terminal-hidden-worktree-retention'

describe('createTerminalWorktreeTopologyProjection', () => {
  function tab(worktreeId: string, id = `tab-${worktreeId}`): TerminalTab {
    return {
      id,
      ptyId: `${worktreeId}@@pty-1`,
      worktreeId,
      title: 'Original title',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
  }

  it('keeps the parking dependency stable for a title-only change across 300 worktrees', () => {
    const inspected: string[] = []
    const projector = createTerminalWorktreeTopologyProjection((worktreeId) =>
      inspected.push(worktreeId)
    )
    const tabs = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => {
        const worktreeId = `wt-${index}`
        return [worktreeId, [tab(worktreeId)]]
      })
    )
    const first = projector.project(tabs)
    inspected.length = 0
    const changedWorktreeId = 'wt-173'
    const second = projector.project({
      ...tabs,
      [changedWorktreeId]: [{ ...tabs[changedWorktreeId][0], title: 'Updated display title' }]
    })

    expect(second).toBe(first)
    expect(inspected).toEqual([changedWorktreeId])
  })

  it.each([
    ['PTY assignment', (original: TerminalTab) => ({ ...original, ptyId: null })],
    [
      'pending spawn',
      (original: TerminalTab) => ({ ...original, pendingActivationSpawn: true as const })
    ],
    ['tab replacement', (original: TerminalTab) => ({ ...original, id: 'tab-2' })],
    ['generation remount', (original: TerminalTab) => ({ ...original, generation: 2 })],
    ['startup cwd', (original: TerminalTab) => ({ ...original, startupCwd: '/tmp' })]
  ])('changes for %s', (_label, mutate) => {
    const projector = createTerminalWorktreeTopologyProjection()
    const originalTab = tab('wt-1', 'tab-1')
    const first = projector.project({ 'wt-1': [originalTab] })
    const second = projector.project({ 'wt-1': [mutate(originalTab)] })

    expect(second).not.toBe(first)
  })

  it('changes for add, remove, and move transitions', () => {
    const projector = createTerminalWorktreeTopologyProjection()
    const first = projector.project({ 'wt-1': [tab('wt-1', 'tab-1')], 'wt-2': [] })
    const added = projector.project({
      'wt-1': [tab('wt-1', 'tab-1'), tab('wt-1', 'tab-2')],
      'wt-2': []
    })
    const removed = projector.project({ 'wt-1': [tab('wt-1', 'tab-2')], 'wt-2': [] })
    const moved = projector.project({
      'wt-1': [],
      'wt-2': [tab('wt-2', 'tab-2')]
    })

    expect(added).not.toBe(first)
    expect(removed).not.toBe(added)
    expect(moved).not.toBe(removed)
  })
})

describe('hasPendingRetentionSpawnWork', () => {
  const remoteTab = {
    id: 'tab-remote',
    ptyId: 'remote:env-1@@terminal-1',
    pendingActivationSpawn: true as const
  }

  it('treats a host-backed paired PTY as settled despite activation residue', () => {
    expect(hasPendingRetentionSpawnWork(remoteTab, {})).toBe(false)
    expect(hasPendingRetentionSpawnWork({ ...remoteTab, pendingActivationSpawn: 2 }, {})).toBe(
      false
    )
  })

  it('preserves real startup work and non-paired activation guards', () => {
    expect(hasPendingRetentionSpawnWork(remoteTab, { [remoteTab.id]: ['echo', 'pending'] })).toBe(
      true
    )
    expect(
      hasPendingRetentionSpawnWork(
        { id: 'tab-local', ptyId: 'pty-local', pendingActivationSpawn: true },
        {}
      )
    ).toBe(true)
    expect(
      hasPendingRetentionSpawnWork(
        { id: 'tab-unbound', ptyId: null, pendingActivationSpawn: true },
        {}
      )
    ).toBe(true)
  })
})

describe('isEvictionExemptTerminalPty', () => {
  const worktreeId = 'repo::/worktree'
  const currentPtyId = `${worktreeId}@@session-1`

  beforeEach(async () => {
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([currentPtyId], async () => [
      { id: currentPtyId, authoritative: true }
    ])
  })
  afterEach(() => clearTerminalProviderSnapshotCapabilities())

  it('exempts only live local ptys a remount could not reattach', () => {
    expect(isEvictionExemptTerminalPty('pty-local-detached', worktreeId)).toBe(true)
    expect(isEvictionExemptTerminalPty('other::wt@@session-1', worktreeId)).toBe(true)
  })

  it('never exempts authoritative, SSH, remote-runtime, or unbound ptys', () => {
    expect(isEvictionExemptTerminalPty(currentPtyId, worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalPty('ssh:conn-1@@pty-1', worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalPty('remote:env-1@@t-1', worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalPty(null, worktreeId)).toBe(false)
  })

  it('exempts a preserved daemon without an authoritative snapshot', async () => {
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([currentPtyId], async () => [
      { id: currentPtyId, authoritative: false }
    ])

    expect(isEvictionExemptTerminalPty(currentPtyId, worktreeId)).toBe(true)
  })
})

describe('selectRetentionForceParkedTerminalWorktrees', () => {
  const nowMs = 5_000_000

  function retentionCandidate(
    worktreeId: string,
    hiddenSinceMs: number | null,
    partial: Partial<TerminalWorktreeRetentionCandidate> = {}
  ): TerminalWorktreeRetentionCandidate {
    return {
      worktreeId,
      hiddenSinceMs,
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      ordinaryParkingCovers: false,
      hasPendingSpawnWork: false,
      ...partial
    }
  }

  const base = {
    parkingEnabled: true,
    retentionBudgetEnabled: true,
    nowMs
  }

  it('returns empty when either kill switch is off', () => {
    const worktrees = [
      retentionCandidate('wt-1', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS)
    ]
    expect(
      selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees, parkingEnabled: false })
    ).toEqual(new Set())
    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees,
        retentionBudgetEnabled: false
      })
    ).toEqual(new Set())
  })

  it('force-parks the least-recently-hidden candidates beyond the retention limit', () => {
    const worktrees = [
      retentionCandidate('wt-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 3),
      retentionCandidate('wt-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2),
      retentionCandidate('wt-3', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
      retentionCandidate('wt-4', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    // Why limit 2: wt-4 is last-active exempt, wt-3 fills the remaining slot; the two oldest evict.
    expect(
      selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees, retentionLimit: 2 })
    ).toEqual(new Set(['wt-1', 'wt-2']))
  })

  it('force-parks past the TTL even under the limit, sparing a last-active candidate inside it', () => {
    const worktrees = [
      retentionCandidate('wt-old', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS),
      retentionCandidate('wt-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees })).toEqual(
      new Set(['wt-old'])
    )
  })

  // Why: the last-active exemption keeps the warm cap's "return is always instant"
  // promise, but carrying it into the eviction clock made "none past 45 minutes"
  // false — a lone hidden un-parkable worktree stayed mounted for the whole session.
  it('force-parks the last-active candidate once it passes the TTL (the exemption bounds the cap, not the clock)', () => {
    const lone = [retentionCandidate('wt-lone', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS)]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees: lone })).toEqual(
      new Set(['wt-lone'])
    )
    const insideTtl = [
      retentionCandidate('wt-lone', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS + 1)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees: insideTtl })).toEqual(
      new Set()
    )
  })

  it('never force-parks visible, measuring, portaled, covered, pending, or fresh candidates', () => {
    const aged = nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
    const worktrees = [
      retentionCandidate('wt-visible', aged, { isVisible: true }),
      retentionCandidate('wt-measure', aged, { shouldMeasureHiddenWorktree: true }),
      retentionCandidate('wt-portal', aged, { hasActivityTerminalPortal: true }),
      retentionCandidate('wt-covered', aged, { ordinaryParkingCovers: true }),
      retentionCandidate('wt-pending', aged, { hasPendingSpawnWork: true }),
      retentionCandidate('wt-fresh', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS + 1),
      retentionCandidate('wt-unhidden', null)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees })).toEqual(new Set())
  })

  // Why: hiddenSince (and with it TTL ranking) survives a measure window, so
  // without the cool-down veto a measured past-TTL worktree would force-park
  // again the instant the lease ends — the remount/reattach thrash Bug #2.
  it('holds a candidate out of force-park until its post-measure cool-down ends', () => {
    const aged = nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
    // Why the recent sibling: it takes the last-active exemption, so the aged
    // candidate's verdict is decided by the cool-down alone.
    const recent = retentionCandidate('wt-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees: [
          retentionCandidate('wt-measured', aged, { parkCooldownUntilMs: nowMs + 1 }),
          recent
        ]
      })
    ).toEqual(new Set())
    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees: [retentionCandidate('wt-measured', aged, { parkCooldownUntilMs: nowMs }), recent]
      })
    ).toEqual(new Set(['wt-measured']))
  })

  it('is idempotent and only grows as time advances (flip-loop dwell)', () => {
    const worktrees = [
      retentionCandidate('wt-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 3),
      retentionCandidate('wt-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2),
      retentionCandidate('wt-3', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
      retentionCandidate('wt-4', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    const first = selectRetentionForceParkedTerminalWorktrees({
      ...base,
      worktrees,
      retentionLimit: 2
    })
    const second = selectRetentionForceParkedTerminalWorktrees({
      ...base,
      worktrees,
      retentionLimit: 2
    })
    expect(second).toEqual(first)
    // Why: with unchanged inputs, a later evaluation may only ADD members —
    // a verdict that oscillates with time is the React-#185 ingredient.
    for (const laterMs of [nowMs + 1_000, nowMs + TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS]) {
      const later = selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees,
        retentionLimit: 2,
        nowMs: laterMs
      })
      for (const id of first) {
        expect(later.has(id)).toBe(true)
      }
    }
  })
})

describe('selectForceParkEvictableTabIds', () => {
  const tabs = [{ id: 'tab-exempt' }, { id: 'tab-evictable' }]

  it('drops eviction-exempt tabs from the capture and unmount set', () => {
    expect(selectForceParkEvictableTabIds(tabs, (tab) => tab.id === 'tab-exempt')).toEqual([
      'tab-evictable'
    ])
  })

  // Why: an all-exempt worktree still reports as force-parked while freeing nothing —
  // the degenerate case a fleet-wide daemon fail-open produces, which the host logs.
  it('yields nothing when every tab is exempt', () => {
    expect(selectForceParkEvictableTabIds(tabs, () => true)).toEqual([])
  })
})

describe('retention pane budget', () => {
  const nowMs = 5_000_000
  const MINUTE = 60_000

  function paneCandidate(
    worktreeId: string,
    hiddenMinutesAgo: number,
    mountedPaneCount: number
  ): TerminalWorktreeRetentionCandidate {
    return {
      worktreeId,
      hiddenSinceMs: nowMs - hiddenMinutesAgo * MINUTE,
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      ordinaryParkingCovers: false,
      hasPendingSpawnWork: false,
      mountedPaneCount
    }
  }

  const select = (
    worktrees: TerminalWorktreeRetentionCandidate[],
    retentionPaneLimit?: number
  ): Set<string> =>
    selectRetentionForceParkedTerminalWorktrees({
      worktrees,
      parkingEnabled: true,
      retentionBudgetEnabled: true,
      nowMs,
      ...(retentionPaneLimit === undefined ? {} : { retentionPaneLimit })
    })

  it('leaves the ordinary working set alone', () => {
    // Four hidden worktrees at one tab each is what the worktree cap was sized
    // for; the pane budget must not touch it.
    const worktrees = [1, 2, 3, 4].map((n) => paneCandidate(`wt-${n}`, n, 1))
    expect(select(worktrees)).toEqual(new Set())
  })

  it('parks past the pane budget even when the worktree cap is satisfied', () => {
    // The measured Windows case: 4 retained worktrees x 4 mounted panes = 16
    // panes, which the count-based cap reports as within budget.
    const worktrees = [1, 2, 3, 4].map((n) => paneCandidate(`wt-${n}`, n, 4))
    // wt-1 (most recently hidden) keeps 4; wt-2 takes it to 8, still within;
    // wt-3 and wt-4 cross it.
    expect(select(worktrees)).toEqual(new Set(['wt-3', 'wt-4']))
  })

  it('never parks the worktree the user just left, however many panes it holds', () => {
    // Why: remounting the view you just switched away from is the cost users
    // actually notice, and one worktree can legitimately exceed the budget.
    const worktrees = [paneCandidate('wt-huge', 1, 40), paneCandidate('wt-small', 2, 1)]
    expect(select(worktrees)).toEqual(new Set(['wt-small']))
  })

  it('evicts least-recently-hidden first', () => {
    const worktrees = [
      paneCandidate('newest', 1, 5),
      paneCandidate('middle', 5, 5),
      paneCandidate('oldest', 9, 5)
    ]
    expect(select(worktrees)).toEqual(new Set(['middle', 'oldest']))
  })

  it('counts an unknown pane count as one rather than free', () => {
    // Why: a worktree whose layout could not be read must never look costless,
    // or a missing layout silently lifts the budget for everything after it.
    const worktrees = [
      paneCandidate('wt-1', 1, 8),
      { ...paneCandidate('wt-2', 2, 1), mountedPaneCount: undefined }
    ]
    expect(select(worktrees)).toEqual(new Set(['wt-2']))
  })

  it('honours an explicit pane limit', () => {
    const worktrees = [1, 2, 3].map((n) => paneCandidate(`wt-${n}`, n, 2))
    expect(select(worktrees, 100)).toEqual(new Set())
    expect(select(worktrees, 2)).toEqual(new Set(['wt-2', 'wt-3']))
  })

  it('stays off when the retention budget is disabled', () => {
    const worktrees = [1, 2, 3, 4].map((n) => paneCandidate(`wt-${n}`, n, 10))
    expect(
      selectRetentionForceParkedTerminalWorktrees({
        worktrees,
        parkingEnabled: true,
        retentionBudgetEnabled: false,
        nowMs
      })
    ).toEqual(new Set())
  })
})

describe('countMountedWorktreePanes', () => {
  it('counts split leaves, and one pane for a tab with no layout row yet', () => {
    expect(
      countMountedWorktreePanes([{ id: 'split' }, { id: 'plain' }, { id: 'empty-layout' }], {
        split: { ptyIdsByLeafId: { a: 'pty-a', b: 'pty-b', c: 'pty-c' } },
        'empty-layout': { ptyIdsByLeafId: {} }
      })
    ).toBe(5)
  })

  it('is zero for a worktree with no tabs', () => {
    expect(countMountedWorktreePanes([], {})).toBe(0)
  })
})

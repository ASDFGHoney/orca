import { describe, expect, it } from 'vitest'
import { createTestStore } from '../store/slices/store-test-helpers'
import {
  DEFAULT_AGENT_HIBERNATION_IDLE_MS,
  planAgentHibernationCandidates,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'

const NOW = 2_000_000
const OLD = NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`

const TAB: TerminalTab = {
  id: 'tab-1',
  ptyId: null,
  worktreeId: 'wt-bg',
  title: 'Agent',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

const LAYOUT: TerminalLayoutSnapshot = {
  root: { type: 'leaf', leafId: LEAF },
  activeLeafId: LEAF,
  expandedLeafId: null,
  ptyIdsByLeafId: { [LEAF]: 'pty-1' }
}

function plannerSnapshotFor(
  agentStatusByPaneKey: AgentHibernationPlannerSnapshot['agentStatusByPaneKey']
): AgentHibernationPlannerSnapshot {
  return {
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    },
    activeWorktreeId: 'wt-active',
    foregroundTerminalTabIds: [],
    tabsByWorktree: { 'wt-bg': [TAB] },
    terminalLayoutsByTabId: { 'tab-1': LAYOUT },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    mobileLockedPtyIds: [],
    agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    foregroundTerminalLastSeenAtByTabId: {},
    now: NOW
  }
}

/** The pane's live-push row: Claude reported a running background shell (the user's dev server). */
const LIVE_BACKGROUND_WORK_PUSH = {
  state: 'done',
  prompt: 'start the dev server',
  agentType: 'claude',
  providerBackgroundWorkActive: true
} as const

// Why: the renderer pulls agentStatus.getSnapshot() after workspace hydration and feeds every row
// through the SAME accepted-write path as the live push, and that write is a write-through. So a
// snapshot row that omits background-work evidence does not merely fail to set it — it ERASES a
// live `true`, and the pane's hibernation guard goes inert with no app restart at all.
describe('hibernation guard survives the snapshot/replay path', () => {
  it('keeps live background-work evidence when the replay restates it, and refuses the pane', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(PANE_KEY, LIVE_BACKGROUND_WORK_PUSH)
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.providerBackgroundWorkActive).toBe(true)

    // The snapshot replay as main now builds it: the evidence travels with the row.
    store.getState().setAgentStatus(PANE_KEY, {
      state: 'done',
      prompt: 'start the dev server',
      agentType: 'claude',
      providerBackgroundWorkActive: true
    })

    const entry = store.getState().agentStatusByPaneKey[PANE_KEY]
    expect(entry?.providerBackgroundWorkActive).toBe(true)
    expect(
      planAgentHibernationCandidates(
        plannerSnapshotFor({ [PANE_KEY]: { ...entry!, updatedAt: OLD, stateStartedAt: OLD } })
      )
    ).toEqual([])
  })

  // Why: this is the pre-fix snapshot shape. The tri-state is what makes even a REGRESSED
  // serializer fail safe: an erased value reads as "never observed", not as "nothing is running".
  it('treats an evidence-less replay as unknown and still refuses the pane', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(PANE_KEY, LIVE_BACKGROUND_WORK_PUSH)

    store.getState().setAgentStatus(PANE_KEY, {
      state: 'done',
      prompt: 'start the dev server',
      agentType: 'claude'
    })

    const entry = store.getState().agentStatusByPaneKey[PANE_KEY]
    expect(entry?.providerBackgroundWorkActive).toBeUndefined()
    expect(
      planAgentHibernationCandidates(
        plannerSnapshotFor({
          [PANE_KEY]: {
            ...entry!,
            updatedAt: OLD,
            stateStartedAt: OLD,
            providerSession: { key: 'session_id', id: 'session-1' }
          }
        })
      )
    ).toEqual([])
  })
})

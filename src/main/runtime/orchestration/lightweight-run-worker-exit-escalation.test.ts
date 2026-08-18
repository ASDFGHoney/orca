import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

// STA-4604: failActiveDispatchOnExit fails the dispatch on worker PTY exit but used to
// gate the "Agent exited unexpectedly" escalation on the legacy coordinator_runs table.
// A lightweight Run (runs + run_coordinator_handles) never populates that table, so
// worker death was silent for its coordinator. The escalation now follows the dispatch's
// own Run to the mailbox `orchestration check` actually reads.

const WORKTREE_ID = 'repo-1::/tmp/sta-4604-worktree'
const WORKER_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const COORDINATOR_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const WORKER_PTY_ID = 'pty-worker'
const COORDINATOR_PTY_ID = 'pty-coordinator'
const WORKER_PANE_KEY = makePaneKey('tab-worker', WORKER_LEAF_ID)
const COORDINATOR_PANE_KEY = makePaneKey('tab-coordinator', COORDINATOR_LEAF_ID)

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/sta-4604-worktree',
        displayName: 'sta-4604',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntimeWithTwoPanes(): {
  runtime: OrcaRuntimeService
  workerHandle: string
  coordinatorHandle: string
} {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: vi.fn(() => true),
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => [])
  } as never)
  const workerHandle = runtime.preAllocateHandleForPty(WORKER_PTY_ID)
  const coordinatorHandle = runtime.preAllocateHandleForPty(COORDINATOR_PTY_ID)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-worker',
        worktreeId: WORKTREE_ID,
        title: 'Worker',
        activeLeafId: WORKER_LEAF_ID,
        layout: null
      },
      {
        tabId: 'tab-coordinator',
        worktreeId: WORKTREE_ID,
        title: 'Coordinator',
        activeLeafId: COORDINATOR_LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-worker',
        worktreeId: WORKTREE_ID,
        leafId: WORKER_LEAF_ID,
        paneRuntimeId: 1,
        ptyId: WORKER_PTY_ID,
        paneTitle: null
      },
      {
        tabId: 'tab-coordinator',
        worktreeId: WORKTREE_ID,
        leafId: COORDINATOR_LEAF_ID,
        paneRuntimeId: 2,
        ptyId: COORDINATOR_PTY_ID,
        paneTitle: null
      }
    ]
  })
  return { runtime, workerHandle, coordinatorHandle }
}

// Pointer delivery runs on a microtask; let it settle before the DB closes.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// The single oracle every mode is graded by: after a worker PTY exit, is the dispatch
// failed, and did the escalation reach a mailbox this coordinator actually reads?
async function gradeWorkerExit(
  mode: 'lightweight-run' | 'legacy-run' | 'legacy-run-no-coordinator'
): Promise<{
  dispatchStatus: string | undefined
  escalationsToCoordinatorHandle: number
  escalationsInRunMailbox: number
  totalUnreadForCoordinator: number
}> {
  const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
  const db = new OrchestrationDb(':memory:')
  try {
    const lightweight = mode === 'lightweight-run'
    const runId = lightweight
      ? db.createRun({
          objective: 'sta-4604 lightweight run',
          coordinatorHandle,
          coordinatorPaneKey: COORDINATOR_PANE_KEY
        }).id
      : LEGACY_RUN_ID
    if (mode === 'legacy-run') {
      db.createCoordinatorRun({ spec: 'legacy coordinator loop', coordinatorHandle })
    }
    const task = db.createTask({ spec: 'do the work', runId })
    const dispatch = db.createDispatchContext(task.id, workerHandle, WORKER_PANE_KEY)
    runtime.setOrchestrationDb(db as never)

    runtime.onPtyExit(WORKER_PTY_ID, 137)
    await settle()

    return {
      dispatchStatus: db.getDispatchContextById(dispatch.id)?.status,
      escalationsToCoordinatorHandle: db.getUnreadMessages(coordinatorHandle, ['escalation'])
        .length,
      escalationsInRunMailbox: db.getUnreadRunMailbox(runId, 100, ['escalation']).length,
      // The ticket's literal claim: the coordinator receives no message of any kind.
      totalUnreadForCoordinator:
        db.getUnreadMessages(coordinatorHandle).length + db.getUnreadRunMailbox(runId, 100).length
    }
  } finally {
    db.close()
  }
}

describe('STA-4604 worker PTY exit escalation reaches the coordinator', () => {
  it('delivers the escalation to a lightweight Run mailbox', async () => {
    await expect(gradeWorkerExit('lightweight-run')).resolves.toEqual({
      dispatchStatus: 'failed',
      // Addressed run:<id> — the only address getOrCreateRunDelivery / getUnreadRunMailbox read.
      escalationsToCoordinatorHandle: 0,
      escalationsInRunMailbox: 1,
      totalUnreadForCoordinator: 1
    })
  })

  it('keeps legacy coordinator_runs delivery on the coordinator handle', async () => {
    await expect(gradeWorkerExit('legacy-run')).resolves.toEqual({
      dispatchStatus: 'failed',
      escalationsToCoordinatorHandle: 1,
      escalationsInRunMailbox: 0,
      totalUnreadForCoordinator: 1
    })
  })

  it('stays silent for a legacy dispatch with no active coordinator', async () => {
    await expect(gradeWorkerExit('legacy-run-no-coordinator')).resolves.toEqual({
      dispatchStatus: 'failed',
      escalationsToCoordinatorHandle: 0,
      escalationsInRunMailbox: 0,
      totalUnreadForCoordinator: 0
    })
  })

  it('wakes a coordinator already blocked in check --wait', async () => {
    const { runtime, workerHandle, coordinatorHandle } = makeRuntimeWithTwoPanes()
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'sta-4604 blocking coordinator',
        coordinatorHandle,
        coordinatorPaneKey: COORDINATOR_PANE_KEY
      })
      const task = db.createTask({ spec: 'do the work', runId: run.id })
      db.createDispatchContext(task.id, workerHandle, WORKER_PANE_KEY)
      runtime.setOrchestrationDb(db as never)

      const waiting = runtime.waitForMessage(`run:${run.id}`, {
        typeFilter: ['escalation'],
        timeoutMs: 2_000
      })
      runtime.onPtyExit(WORKER_PTY_ID, 137)

      await expect(waiting).resolves.toBe('notified')
      await settle()
    } finally {
      db.close()
    }
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE, RUNNING_SHELL } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Why: the renderer pulls getStatusSnapshot after workspace hydration and feeds it through the
// same accepted-write path as the live push. If the snapshot omits background-work evidence the
// pane's hibernation guard goes inert with no app restart at all — the guard exists but its value
// never reaches the planner.
describe('status snapshot carries provider background-work evidence', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-snapshot-bgwork-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('reports active background work on the snapshot path, not only the live push', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
      )
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
      )

      const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
      expect(row?.state).toBe('done')
      expect(row?.providerBackgroundWorkActive).toBe(true)
    } finally {
      server.stop()
    }
  })

  it('reports background work as positively absent once the inventory clears', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'run a task' })
      )
      await postHookEvent(server, buildBody({ hook_event_name: 'Stop', background_tasks: [] }))

      const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
      expect(row?.state).toBe('done')
      // Why: positively observed "no background work" must be distinguishable from
      // "never observed", which is what makes the planner's tri-state fail closed.
      expect(row?.providerBackgroundWorkActive).toBe(false)
    } finally {
      server.stop()
    }
  })

  // Why: an interrupt CLEARS the inventory sets to stop gating the pane. That is not the provider
  // reporting an all-clear, so it must leave the pane "never observed" (unknown) rather than
  // manufacturing a positive `false` over a process that may still be running.
  it('reports unknown, not a false all-clear, after an interrupt', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
      )
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
      )
      expect(
        server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
          ?.providerBackgroundWorkActive
      ).toBe(true)

      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'Stop', is_interrupt: true, background_tasks: [] })
      )

      expect(
        server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
          ?.providerBackgroundWorkActive
      ).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  // Why: a scheduled session cron is provider-owned work under this PTY just as a background shell
  // is. A cron-only inventory must both COUNT as an observation and resolve to live work.
  it('treats a cron-only inventory as observed live background work', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'schedule a job' })
      )
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'Stop', session_crons: [{ id: 'cron-1' }] })
      )

      const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
      expect(row?.providerBackgroundWorkActive).toBe(true)
    } finally {
      server.stop()
    }
  })

  // Why: a relayed host reports the inventory as a wire boolean. If the receiving runtime does not
  // record that an observation happened, every remote pane stays "never observed" forever and a
  // relayed all-clear can never make one eligible.
  it('records remote/relayed background-work evidence as an observation', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'Stop',
          claudeRunningNonAgentTask: false,
          payload: { state: 'done', prompt: 'remote turn', agentType: 'claude' }
        },
        'conn-remote-1'
      )

      const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
      expect(row?.state).toBe('done')
      expect(row?.providerBackgroundWorkActive).toBe(false)
    } finally {
      server.stop()
    }
  })
})

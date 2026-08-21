import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function ingestWorking(
  server: AgentHookServer,
  payload: {
    prompt: string
    agentType: 'claude' | 'codex' | 'opencode'
    hookEventName?: string
  }
): ReturnType<AgentHookServer['getStatusSnapshot']>[0] {
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      hasExplicitPrompt: true,
      hookEventName: payload.hookEventName ?? 'UserPromptSubmit',
      payload: {
        state: 'working',
        prompt: payload.prompt,
        agentType: payload.agentType
      }
    },
    'conn-1'
  )
  return server.getStatusSnapshot()[0]!
}

// Why: take the snapshot row type itself rather than a hand-written structural
// shape - the payload's fields are optional, so a narrower literal type does not
// accept it and typecheck fails (tests are excluded from the mobile tsconfig but
// not from this one).
function inferEscape(
  server: AgentHookServer,
  baseline: ReturnType<AgentHookServer['getStatusSnapshot']>[0]
) {
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: baseline.agentType,
    intent: 'plain-escape'
  })
}

describe('interrupt inference yields to a live working hook row', () => {
  it('does not retire a working Claude turn when Escape is consumed as TUI navigation', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const baseline = ingestWorking(server, { prompt: 'long tool call', agentType: 'claude' })

      vi.setSystemTime(1_500)
      expect(inferEscape(server, baseline)).toBe(false)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        prompt: 'long tool call',
        agentType: 'claude',
        interrupted: undefined
      })

      vi.setSystemTime(12_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'Stop',
          payload: { state: 'done', prompt: 'long tool call', agentType: 'claude' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        prompt: 'long tool call',
        agentType: 'claude',
        interrupted: undefined
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a working row live when a later same-turn tool hook arrives after Escape', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const baseline = ingestWorking(server, { prompt: 'still running', agentType: 'claude' })

      vi.setSystemTime(1_500)
      expect(inferEscape(server, baseline)).toBe(false)

      vi.setSystemTime(2_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'PostToolUse',
          payload: {
            state: 'working',
            prompt: 'still running',
            agentType: 'claude',
            toolName: 'Bash',
            toolInput: 'sleep 90'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        prompt: 'still running',
        agentType: 'claude',
        toolName: 'Bash',
        interrupted: undefined
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a real Claude interrupt from the Stop hook, not from Escape inference', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const baseline = ingestWorking(server, { prompt: 'cancel me', agentType: 'claude' })

      vi.setSystemTime(1_200)
      expect(inferEscape(server, baseline)).toBe(false)
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })

      vi.setSystemTime(1_300)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'Stop',
          payload: {
            state: 'done',
            prompt: 'cancel me',
            agentType: 'claude',
            interrupted: true
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        prompt: 'cancel me',
        agentType: 'claude',
        interrupted: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not latch working after a hook-confirmed interrupt, and late tool progress cannot resurrect it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const baseline = ingestWorking(server, { prompt: 'stop the turn', agentType: 'claude' })

      vi.setSystemTime(1_200)
      expect(inferEscape(server, baseline)).toBe(false)

      vi.setSystemTime(1_300)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'Stop',
          payload: {
            state: 'done',
            prompt: 'stop the turn',
            agentType: 'claude',
            interrupted: true
          }
        },
        'conn-1'
      )

      vi.setSystemTime(2_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'PostToolUse',
          payload: {
            state: 'working',
            prompt: 'stop the turn',
            agentType: 'claude',
            toolName: 'Bash',
            toolInput: 'sleep 90'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        prompt: 'stop the turn',
        agentType: 'claude',
        interrupted: true,
        receivedAt: 1_300
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps interrupted onto a lead done for agents that omit is_interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const baseline = ingestWorking(server, { prompt: 'long task', agentType: 'opencode' })

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'long task',
          baselineAgentType: 'opencode',
          intent: 'plain-escape',
          inputCount: 2
        })
      ).toBe(false)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        interrupted: undefined
      })

      vi.setSystemTime(1_501)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'done', prompt: 'long task', agentType: 'opencode' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        prompt: 'long task',
        agentType: 'opencode',
        interrupted: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

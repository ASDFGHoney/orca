import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_SUBMIT_DELAY_MS
} from '../../shared/agent-prompt-injection'
import type { TuiAgent } from '../../shared/tui-agent'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

const WORKTREE_PATH = '/tmp/worktree-a'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-delivery-state-machine',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-delivery-state-machine',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

async function createPromptRuntime(options: {
  launchAgent: TuiAgent
  foregroundAgent?: TuiAgent
  onWrite?: (runtime: OrcaRuntimeService, data: string) => void
}): Promise<{ runtime: OrcaRuntimeService; handle: string; writes: string[] }> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const writes: string[] = []
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
    write: (_ptyId, data) => {
      writes.push(data)
      options.onWrite?.(runtime, data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => options.foregroundAgent ?? options.launchAgent
  })
  const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
    launchAgent: options.launchAgent
  })
  return { runtime, handle: terminal.handle, writes }
}

describe('agent prompt delivery state machine', () => {
  afterEach(() => vi.useRealTimers())

  it('submits OpenCode only after fresh post-paste readiness', async () => {
    vi.useFakeTimers()
    let composerReady = false
    let acceptedEnters = 0
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      onWrite: (runtime, data) => {
        if (data !== '\r' || !composerReady) {
          return
        }
        acceptedEnters += 1
        runtime.onPtyData('pty-prompt', '\x1b]0;OpenCode working\x07', Date.now())
      }
    })
    runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')

    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_SUBMIT_DELAY_MS)
    expect(writes).not.toContain('\r')
    composerReady = true
    runtime.onPtyData('pty-prompt', '\x1b[?2', Date.now())
    runtime.onPtyData('pty-prompt', '5h', Date.now())
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(acceptedEnters).toBe(1)
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it.each(['claude', 'codex'] as const)(
    'reports %s local-command output as unknown without lifecycle evidence',
    async (agent) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createPromptRuntime({
        launchAgent: agent,
        onWrite: (runtime, data) => {
          if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
            runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
          }
          if (data === '\r') {
            runtime.onPtyData('pty-prompt', 'Unknown command\r\n', Date.now())
          }
        }
      })
      const outcome = runtime
        .sendTerminalAgentPrompt(handle, '/not-a-command')
        .catch((error: unknown) => error)

      await vi.runAllTimersAsync()

      await expect(outcome).resolves.toMatchObject({
        code: 'operation_unknown',
        data: { operation: 'agent_prompt_delivery', reason: 'agent_prompt_stalled' }
      })
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    }
  )

  it('does not accept an OpenCode redraw after a swallowed Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      onWrite: (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
        }
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b[2J\x1b[H› review this', Date.now())
        }
      }
    })
    const outcome = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { operation: 'agent_prompt_delivery', reason: 'agent_prompt_stalled' }
    })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('retains uncertainty without Enter when OpenCode never becomes ready', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({ launchAgent: 'opencode' })
    const outcome = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      code: 'operation_unknown',
      data: { operation: 'agent_prompt_delivery', reason: 'agent_prompt_not_ready' }
    })
    expect(writes).not.toContain('\r')
  })

  it('uses current OpenCode policy instead of stale Codex launch metadata', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'codex',
      foregroundAgent: 'opencode'
    })
    const outcome = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)

    await vi.runAllTimersAsync()

    await expect(outcome).resolves.toMatchObject({
      data: { reason: 'agent_prompt_not_ready' }
    })
    expect(writes).not.toContain('\r')
  })

  it('uses current Codex policy instead of stale OpenCode launch metadata', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({
      launchAgent: 'opencode',
      foregroundAgent: 'codex',
      onWrite: (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')

    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('rejects direct input while an agent prompt owns PTY input', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime({ launchAgent: 'opencode' })
    const promptOutcome = runtime
      .sendTerminalAgentPrompt(handle, 'review this')
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)

    await expect(runtime.sendTerminal(handle, { text: 'manual input' })).rejects.toThrow(
      'terminal_input_busy'
    )
    await vi.runAllTimersAsync()

    await expect(promptOutcome).resolves.toMatchObject({ code: 'operation_unknown' })
    expect(writes.join('')).not.toContain('manual input')
  })

  it('refuses a prompt before paste while direct input is in flight', async () => {
    let releaseWrite!: () => void
    let enteredWrite!: () => void
    const entered = new Promise<void>((resolve) => {
      enteredWrite = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const { runtime, handle, writes } = await createPromptRuntime({ launchAgent: 'aider' })
    const direct = runtime.sendTerminal(
      handle,
      { text: 'manual input' },
      {
        beforeWrite: async () => {
          enteredWrite()
          await blocked
        }
      }
    )
    await entered

    await expect(runtime.sendTerminalAgentPrompt(handle, 'review this')).rejects.toThrow(
      'terminal_input_busy'
    )
    releaseWrite()
    await direct

    expect(writes.join('')).toContain('manual input')
    expect(writes.join('')).not.toContain('review this')
  })
})

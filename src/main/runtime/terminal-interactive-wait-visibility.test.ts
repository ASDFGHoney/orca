// STA-4513 / STA-3714: a worker parked on an interactive prompt must be distinguishable
// from one that is thinking or inside a long tool call. Before this, `terminal show` and
// `orchestration worker-show` carried no such field, and cursor-agent's approval menu was
// not detected at all — its hook set has no approval event, so control and case reported
// byte-identical `working` on every coordinator surface.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const PTY_ID = 'pty-1'

// Captured verbatim from cursor-agent 2026.08.11-e8db854 driven through Orca.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}
const CURSOR_APPROVAL = fixture('cursor-agent-approval-prompt')
const CURSOR_LONG_TOOL_CALL = fixture('cursor-agent-long-tool-call')
const CURSOR_IDLE = fixture('cursor-agent-idle-after-approval')

// Claude Code 2.1.234's own trust screen, which the runtime already matched by shape.
const CLAUDE_TRUST = [
  'Accessing workspace:\n',
  '/private/tmp/repo\n',
  'Quick safety check: Is this a project you created or one you trust?\n',
  '❯ 1. Yes, I trust this folder\n',
  '  2. No, exit\n'
].join('')

function agentStatusOsc(state: string): string {
  return `]9999;${JSON.stringify({ state, prompt: 'ship it', agentType: 'claude' })}`
}

async function createPane(options: {
  paneTitle: string
  foregroundProcess: string | null
  data: string
}): Promise<{ runtime: OrcaRuntimeService; handle: string }> {
  const runtime = new OrcaRuntimeService(null)
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID, incarnationId: 'inc-1' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => options.foregroundProcess
  })
  const terminal = await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    title: 'Terminal'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: options.paneTitle
      }
    ]
  })
  runtime.onPtyData(PTY_ID, options.data, Date.now())
  return { runtime, handle: terminal.handle }
}

// cursor-agent renders a braille spinner in its OSC title while it works, and Orca reads
// that as `working`; the title is identical whether it is running a command or waiting.
const CURSOR_TITLE = '⠇ Cursor Agent'

describe('terminal interactive-wait visibility (STA-4513, STA-3714)', () => {
  describe('cursor-agent approval menu, the case no hook reports', () => {
    it('names the pending approval on the pane a coordinator inspects', async () => {
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: CURSOR_APPROVAL
      })

      await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
        agentWait: { source: 'prompt-text', reason: 'agent-approval-prompt' }
      })
      expect(runtime.getTerminalInteractiveWait(handle)).toMatchObject({
        source: 'prompt-text',
        reason: 'agent-approval-prompt',
        since: expect.any(Number)
      })
    })

    it('feeds the same permission verdict the agent-prompt guard reads', async () => {
      // Why this matters beyond reporting: `dispatch --inject` and guarded sends refuse on a
      // `permission` verdict, so before this the coordinator's preamble was typed straight
      // into the approval dialog instead of being refused (the STA-2631 shape).
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: CURSOR_APPROVAL
      })

      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: 'permission'
      })
    })

    it('refuses to call the lane idle while the approval is unanswered', async () => {
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: CURSOR_APPROVAL
      })

      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 400 })
      ).resolves.toMatchObject({ satisfied: false, blockedReason: 'agent-approval-prompt' })
    })

    it('reports no wait for the same agent inside a long tool call', async () => {
      // The control: identical vendor, identical spinner title, a real `sleep 60` running.
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: CURSOR_LONG_TOOL_CALL
      })

      expect(runtime.getTerminalInteractiveWait(handle)).toBeNull()
      await expect(runtime.showTerminal(handle)).resolves.toMatchObject({ agentWait: null })
    })

    it('reports no wait once the agent is idle again', async () => {
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: CURSOR_IDLE
      })

      expect(runtime.getTerminalInteractiveWait(handle)).toBeNull()
    })

    it('treats an answered menu still in scrollback as scrollback', async () => {
      // Why: the menu is not erased on every terminal; cursor-agent's follow-up input line
      // reappearing after it is the proof that a human already answered.
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: `${CURSOR_APPROVAL}\n${CURSOR_IDLE}`
      })

      expect(runtime.getTerminalInteractiveWait(handle)).toBeNull()
    })

    it('ignores a partial menu that names no decision keys', async () => {
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: 'The agent asked: Run this command? I said yes and it worked.\n'
      })

      expect(runtime.getTerminalInteractiveWait(handle)).toBeNull()
    })
  })

  describe('prompts the runtime already matched but never surfaced', () => {
    it('surfaces a startup trust screen on the pane, not only on terminal wait', async () => {
      // A pane on its trust screen still wears Orca's tab title; the agent has set none.
      const { runtime, handle } = await createPane({
        paneTitle: 'sta4513-claude',
        foregroundProcess: 'claude',
        data: CLAUDE_TRUST
      })

      await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
        agentWait: { source: 'prompt-text', reason: 'codex-trust-workspace' }
      })
    })

    it('still lets a live working title clear a stale startup prompt', async () => {
      // Pins the shared authority getTerminalAgentStatus and the agent-prompt send guard
      // already use: for the startup modals, a live non-permission title is the staleness
      // proof, because their text survives in scrollback with no self-dismissal marker.
      const { runtime, handle } = await createPane({
        paneTitle: '✻ Claude Code',
        foregroundProcess: 'claude',
        data: CLAUDE_TRUST
      })

      expect(runtime.getTerminalInteractiveWait(handle)).toBeNull()
    })
  })

  describe('hook-reported waits (STA-3714)', () => {
    it('surfaces an agent-reported blocked state with hook provenance', async () => {
      const { runtime, handle } = await createPane({
        paneTitle: '✻ Claude Code',
        foregroundProcess: 'claude',
        data: agentStatusOsc('waiting')
      })

      expect(runtime.getTerminalInteractiveWait(handle)).toMatchObject({
        source: 'hook',
        since: expect.any(Number)
      })
      await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
        agentWait: { source: 'hook' }
      })
    })

    it('reports no wait for a hook-reported working turn', async () => {
      const { runtime, handle } = await createPane({
        paneTitle: '✻ Claude Code',
        foregroundProcess: 'claude',
        data: agentStatusOsc('working')
      })

      expect(runtime.getTerminalInteractiveWait(handle)).toBeNull()
    })

    it('drops a retained permission row once a shell owns the pane', async () => {
      const { runtime, handle } = await createPane({
        paneTitle: 'zsh',
        foregroundProcess: 'zsh',
        data: agentStatusOsc('blocked')
      })

      expect(runtime.getTerminalInteractiveWait(handle)).toBeNull()
    })
  })

  it('answers null rather than "not waiting" for a pane it cannot read', async () => {
    const { runtime } = await createPane({
      paneTitle: CURSOR_TITLE,
      foregroundProcess: 'cursor-agent',
      data: CURSOR_APPROVAL
    })

    expect(runtime.getTerminalInteractiveWait('term_does_not_exist')).toBeNull()
  })
})

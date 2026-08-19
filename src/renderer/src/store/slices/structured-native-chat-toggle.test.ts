import { describe, expect, it, vi } from 'vitest'
import {
  nativeChatRouteForAgent,
  nativeChatRouteForTerminal,
  setTerminalNativeChatMode
} from './structured-native-chat-toggle'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('native chat routing', () => {
  it.each([
    ['codex', 'structured'],
    ['claude', 'bridge'],
    ['openclaude', 'bridge'],
    ['grok', 'bridge'],
    ['omp', 'bridge']
  ] as const)('routes %s to %s', (agent, route) => {
    expect(nativeChatRouteForAgent(agent)).toBe(route)
  })

  it('keeps an adopted terminal structured after live Codex evidence disappears', () => {
    expect(
      nativeChatRouteForTerminal({
        agent: null,
        structuredSessionId: 'codex_thread-1',
        mode: 'terminal'
      })
    ).toBe('structured')
  })

  it('lets a pre-migration Codex bridge return to the terminal before adoption', () => {
    expect(nativeChatRouteForTerminal({ agent: 'codex', mode: 'terminal' })).toBe('bridge')
  })

  it('retains the durable binding when the first handoff attempt fails', async () => {
    const tab = {
      id: 'tab-1',
      entityId: 'terminal-1',
      worktreeId: 'workspace-1',
      contentType: 'terminal' as const
    }
    const state = {
      unifiedTabsByWorktree: { 'workspace-1': [tab] },
      tabsByWorktree: { 'workspace-1': [{ id: 'terminal-1', launchAgent: 'codex' }] },
      terminalLayoutsByTabId: {
        'terminal-1': {
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      },
      agentStatusByPaneKey: {
        'terminal-1:leaf-1': {
          agentType: 'codex',
          providerSession: { id: 'thread-1' }
        }
      }
    }
    vi.mocked(callStructuredAgentSession)
      .mockResolvedValueOnce({ ok: true, fence: 1 })
      .mockRejectedValueOnce(new Error('method_not_found'))
    const patch = vi.fn()

    const result = await setTerminalNativeChatMode({
      getState: () => state as never,
      patch,
      tabId: tab.id,
      mode: 'chat'
    })

    expect(result).toBe('ignored')
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith(tab.id, {
      structuredSessionId: 'codex_thread-1'
    })
  })

  it('adopts from trusted foreground Codex evidence before hooks publish a thread', async () => {
    vi.mocked(callStructuredAgentSession).mockReset()
    const tab = {
      id: 'tab-foreground',
      entityId: 'terminal-foreground',
      worktreeId: 'workspace-1',
      contentType: 'terminal' as const
    }
    const paneKey = 'terminal-foreground:leaf-1'
    const state = {
      unifiedTabsByWorktree: { 'workspace-1': [tab] },
      tabsByWorktree: { 'workspace-1': [{ id: 'terminal-foreground' }] },
      terminalLayoutsByTabId: {
        'terminal-foreground': {
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-foreground' }
        }
      },
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'codex', shellForeground: false, routingTrusted: true }
      }
    }
    vi.mocked(callStructuredAgentSession)
      .mockResolvedValueOnce({ ok: true, fence: 1 })
      .mockRejectedValueOnce(new Error('handoff failed'))
    const patch = vi.fn()

    await expect(
      setTerminalNativeChatMode({
        getState: () => state as never,
        patch,
        tabId: tab.id,
        mode: 'chat'
      })
    ).resolves.toBe('ignored')
    expect(vi.mocked(callStructuredAgentSession).mock.calls[0]?.[2]).not.toHaveProperty('threadId')
    expect(patch).toHaveBeenCalledWith(
      tab.id,
      expect.objectContaining({ structuredSessionId: expect.stringMatching(/^codex_adopt-/) })
    )
  })
})

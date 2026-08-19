import { toast } from 'sonner'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  AgentSessionAttachResult,
  AgentSessionHistoryResult,
  AgentSessionHandoffStatus,
  AgentSessionMutationResult
} from '../../../../shared/agent-session-wire'
import type { Tab } from '../../../../shared/tab-types'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../../shared/structured-agent-session-mutation'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../types'

export type NativeChatRoute = 'structured' | 'bridge'

export function nativeChatRouteForAgent(agent: AgentType | null): NativeChatRoute {
  return agent === 'codex' ? 'structured' : 'bridge'
}

export function nativeChatRouteForTerminal(input: {
  agent: AgentType | null
  structuredSessionId?: string
  mode: 'terminal' | 'chat'
}): NativeChatRoute {
  if (input.structuredSessionId) {
    return 'structured'
  }
  return input.mode === 'chat' ? nativeChatRouteForAgent(input.agent) : 'bridge'
}

function activeTerminalFacts(state: AppState, tab: Tab) {
  const terminal = (state.tabsByWorktree[tab.worktreeId] ?? []).find(
    (candidate) => candidate.id === tab.entityId
  )
  const layout = state.terminalLayoutsByTabId[tab.entityId]
  const leafId = layout?.activeLeafId ?? null
  const paneKey = leafId ? `${tab.entityId}:${leafId}` : null
  const status = paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
  const foreground = paneKey ? state.paneForegroundAgentByPaneKey?.[paneKey] : undefined
  const foregroundAgent =
    foreground?.agent && !foreground.shellForeground && !foreground.routingRevoked
      ? foreground.agent
      : null
  const agent =
    status?.agentType ??
    foregroundAgent ??
    terminal?.launchAgent ??
    resolveCommittedTitleAgentType(tab.label) ??
    resolveCommittedTitleAgentType(terminal?.title ?? '')
  const ptyId = leafId ? layout?.ptyIdsByLeafId?.[leafId] : null
  return {
    agent: agent ?? null,
    paneKey,
    ptyId: ptyId ?? null,
    threadId: status?.providerSession?.id
  }
}

function adoptedSessionId(threadId: string): string {
  return `codex_${threadId.replaceAll(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 128)
}

function operationId(): string {
  return createStructuredAgentSessionOperationId(() => crypto.randomUUID())
}

async function currentFence(sessionId: string): Promise<number> {
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    { kind: 'local' },
    'agentSession.history',
    { sessionId, direction: 'tail', limit: 1 }
  )
  const fence = history.ok ? history.page.fence : history.fence
  if (!fence) {
    throw new Error('Structured Codex chat did not publish an ownership fence.')
  }
  return fence
}

async function waitForOwner(
  sessionId: string,
  owner: 'native' | 'tui'
): Promise<AgentSessionHandoffStatus> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await callStructuredAgentSession<AgentSessionHandoffStatus>(
      { kind: 'local' },
      'agentSession.handoffStatus',
      { sessionId }
    )
    if (status.phase === 'failed') {
      throw new Error(status.error?.message ?? 'Codex ownership transfer failed.')
    }
    if (status.owner === owner && status.phase === 'idle') {
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Codex ownership transfer did not finish.')
}

async function requestHandoff(
  sessionId: string,
  direction: 'to-native' | 'to-tui',
  fence: number
): Promise<void> {
  const fields = { direction, mode: 'after-turn' as const, action: 'start' as const }
  const result = await callStructuredAgentSession<AgentSessionMutationResult<unknown>>(
    { kind: 'local' },
    'agentSession.handoff',
    {
      envelope: {
        sessionId,
        clientOperationId: operationId(),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.requestHandoff',
          sessionId,
          fields
        })
      },
      ...fields
    }
  )
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
}

const pendingTabs = new Set<string>()

export async function setTerminalNativeChatMode(input: {
  getState: () => AppState
  patch: (tabId: string, patch: Partial<Tab>) => void
  tabId: string
  mode: 'terminal' | 'chat'
}): Promise<'structured' | 'bridge' | 'ignored'> {
  if (pendingTabs.has(input.tabId)) {
    return 'ignored'
  }
  const tab = Object.values(input.getState().unifiedTabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === input.tabId)
  if (!tab || tab.contentType !== 'terminal') {
    return 'ignored'
  }
  const facts = activeTerminalFacts(input.getState(), tab)
  if (
    nativeChatRouteForTerminal({
      agent: facts.agent,
      structuredSessionId: tab.structuredSessionId,
      mode: input.mode
    }) === 'bridge'
  ) {
    input.patch(tab.id, { viewMode: input.mode })
    return 'bridge'
  }
  pendingTabs.add(tab.id)
  try {
    let sessionId = tab.structuredSessionId
    let fence: number
    if (!sessionId) {
      if (!facts.paneKey || !facts.ptyId) {
        throw new Error('Codex has not published a resumable terminal pane yet.')
      }
      sessionId = facts.threadId
        ? adoptedSessionId(facts.threadId)
        : adoptedSessionId(`adopt-${crypto.randomUUID()}`)
      const worktree = `id:${tab.worktreeId}`
      const fields = {
        worktree,
        tabId: tab.entityId,
        paneKey: facts.paneKey,
        ptyId: facts.ptyId,
        ...(facts.threadId ? { threadId: facts.threadId } : {})
      }
      const adopted = await callStructuredAgentSession<
        AgentSessionMutationResult<AgentSessionAttachResult>
      >({ kind: 'local' }, 'agentSession.adoptTerminal', {
        envelope: {
          sessionId,
          clientOperationId: operationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: structuredAgentSessionPayloadFingerprint({
            method: 'agentSession.adoptTerminal',
            sessionId,
            fields
          })
        },
        ...fields
      })
      if (!adopted.ok) {
        throw new Error(adopted.refusal.message)
      }
      // Keep the durable binding retryable if the following ownership transfer fails.
      input.patch(tab.id, { structuredSessionId: sessionId })
      fence = adopted.fence
    } else {
      fence = await currentFence(sessionId)
    }
    const direction = input.mode === 'chat' ? 'to-native' : 'to-tui'
    await requestHandoff(sessionId, direction, fence)
    await waitForOwner(sessionId, input.mode === 'chat' ? 'native' : 'tui')
    input.patch(tab.id, { structuredSessionId: sessionId, viewMode: input.mode })
    return 'structured'
  } catch (error) {
    toast.error(
      translate(
        'components.native-chat.structuredAdoptionFailed',
        'Could not switch this Codex session to structured chat'
      ),
      { description: error instanceof Error ? error.message : String(error) }
    )
    return 'ignored'
  } finally {
    pendingTabs.delete(tab.id)
  }
}

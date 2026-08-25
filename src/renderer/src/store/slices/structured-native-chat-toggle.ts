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
import { canUseStructuredNativeChat } from '@/lib/structured-native-chat-availability'
import type { AppState } from '../types'

export type NativeChatRoute = 'structured' | 'bridge'

export function nativeChatRouteForAgent(agent: AgentType | null): NativeChatRoute {
  return agent === 'codex' || agent === 'claude' ? 'structured' : 'bridge'
}

export function nativeChatRouteForTerminal(input: {
  agent: AgentType | null
  structuredSessionId?: string
  mode: 'terminal' | 'chat'
  structuredAvailable?: boolean
}): NativeChatRoute {
  if (input.structuredAvailable === false) {
    return 'bridge'
  }
  if (input.structuredSessionId) {
    return (input.agent === null || input.agent === 'codex' || input.agent === 'claude') &&
      (input.agent === null ||
        structuredSessionProviderMatches(input.structuredSessionId, input.agent))
      ? 'structured'
      : 'bridge'
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
    threadId: status?.providerSession?.id,
    providerTranscriptPath: status?.providerSession?.transcriptPath
  }
}

function adoptedSessionId(agent: 'claude' | 'codex', providerSessionId: string): string {
  return `${agent}_${providerSessionId.replaceAll(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 128)
}

function structuredSessionProviderMatches(sessionId: string, agent: AgentType | null): boolean {
  if (agent !== 'claude' && agent !== 'codex') {
    return false
  }
  return sessionId.startsWith(`${agent}_`)
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
    throw new Error('Structured chat did not publish an ownership fence.')
  }
  return fence
}

async function waitForOwner(
  sessionId: string,
  owner: 'native' | 'tui',
  agent: 'claude' | 'codex'
): Promise<AgentSessionHandoffStatus> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await callStructuredAgentSession<AgentSessionHandoffStatus>(
      { kind: 'local' },
      'agentSession.handoffStatus',
      { sessionId }
    )
    if (status.phase === 'failed') {
      return status
    }
    if (status.owner === owner && status.phase === 'idle') {
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${agent} ownership transfer did not finish.`)
}

async function requestHandoff(
  sessionId: string,
  direction: 'to-native' | 'to-tui',
  fence: number,
  clientOperationId: string,
  action: 'start' | 'retry'
): Promise<void> {
  const fields = { direction, mode: 'after-turn' as const, action }
  const result = await callStructuredAgentSession<AgentSessionMutationResult<unknown>>(
    { kind: 'local' },
    'agentSession.handoff',
    {
      envelope: {
        sessionId,
        clientOperationId,
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

async function recoverableHandoffOperation(
  sessionId: string,
  direction: 'to-native' | 'to-tui'
): Promise<string | null> {
  const status = await callStructuredAgentSession<AgentSessionHandoffStatus>(
    { kind: 'local' },
    'agentSession.handoffStatus',
    { sessionId }
  )
  return status.phase === 'failed' &&
    status.direction === direction &&
    status.operationId &&
    status.error?.recoverableOwner !== 'none'
    ? status.operationId
    : null
}

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
  const structuredAvailable = canUseStructuredNativeChat(input.getState(), tab.worktreeId)
  if (
    nativeChatRouteForTerminal({
      agent: facts.agent,
      structuredSessionId: tab.structuredSessionId,
      mode: input.mode,
      structuredAvailable
    }) === 'bridge'
  ) {
    input.patch(tab.id, {
      viewMode: input.mode,
      ...(tab.structuredSessionId &&
      !structuredSessionProviderMatches(tab.structuredSessionId, facts.agent)
        ? { structuredSessionId: undefined }
        : {})
    })
    return 'bridge'
  }
  pendingTabs.add(tab.id)
  let sessionId: string | undefined = tab.structuredSessionId
  try {
    const provider = facts.agent === 'claude' ? 'claude' : 'codex'
    let fence: number
    if (!sessionId) {
      if (!facts.paneKey || !facts.ptyId) {
        throw new Error(
          `${provider === 'claude' ? 'Claude' : 'Codex'} has not published a resumable terminal pane yet.`
        )
      }
      sessionId = facts.threadId
        ? adoptedSessionId(provider, facts.threadId)
        : adoptedSessionId(provider, `adopt-${crypto.randomUUID()}`)
      const worktree = `id:${tab.worktreeId}`
      const fields = {
        worktree,
        tabId: tab.entityId,
        paneKey: facts.paneKey,
        ptyId: facts.ptyId,
        agent: provider,
        ...(facts.threadId ? { providerSessionId: facts.threadId } : {}),
        ...(facts.providerTranscriptPath
          ? { providerTranscriptPath: facts.providerTranscriptPath }
          : {})
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
      input.patch(tab.id, { structuredSessionId: sessionId, agentSessionAgent: provider })
      fence = adopted.fence
    } else {
      fence = await currentFence(sessionId)
    }
    const direction = input.mode === 'chat' ? 'to-native' : 'to-tui'
    const recoverableOperationId = await recoverableHandoffOperation(sessionId, direction)
    const handoffOperationId = recoverableOperationId ?? operationId()
    await requestHandoff(
      sessionId,
      direction,
      fence,
      handoffOperationId,
      recoverableOperationId ? 'retry' : 'start'
    )
    const status = await waitForOwner(sessionId, input.mode === 'chat' ? 'native' : 'tui', provider)
    if (status.phase === 'failed') {
      throw new Error(
        status.error?.details ??
          status.error?.message ??
          `${facts.agent === 'claude' ? 'Claude' : 'Codex'} ownership transfer failed.`
      )
    }
    input.patch(tab.id, {
      structuredSessionId: sessionId,
      agentSessionAgent: provider,
      viewMode: input.mode
    })
    return 'structured'
  } catch (error) {
    // Adoption binds the durable session before the owner transfer starts. If the
    // transfer is refused, keep that binding retryable but reveal the live TUI again.
    if (input.mode === 'chat' && sessionId) {
      input.patch(tab.id, { viewMode: 'terminal' })
    }
    const agentLabel = facts.agent === 'claude' ? 'Claude' : 'Codex'
    toast.error(
      facts.agent === 'claude'
        ? input.mode === 'chat'
          ? 'Could not switch this Claude session to structured chat'
          : 'Could not return this Claude session to the terminal'
        : translate(
            input.mode === 'chat'
              ? 'components.native-chat.structuredAdoptionFailed'
              : 'components.native-chat.structuredReturnToTerminalFailed',
            input.mode === 'chat'
              ? `Could not switch this ${agentLabel} session to structured chat`
              : `Could not return this ${agentLabel} session to the terminal`
          ),
      { description: error instanceof Error ? error.message : String(error) }
    )
    return 'ignored'
  } finally {
    pendingTabs.delete(tab.id)
  }
}

import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

function newSessionId(agent: 'claude' | 'codex'): string {
  return `${agent}_${crypto.randomUUID().replaceAll('-', '_')}`
}

export async function launchStructuredAgentSession(
  worktreeId: string,
  agent: 'claude' | 'codex'
): Promise<string> {
  const sessionId = newSessionId(agent)
  const fields = { worktree: toRuntimeWorktreeSelector(worktreeId), agent }
  const result = await callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionAttachResult>
  >({ kind: 'local' }, 'agentSession.create', {
    envelope: {
      sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId,
        fields
      })
    },
    ...fields
  })
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
  return result.value.sessionId
}

export function launchStructuredCodexSession(worktreeId: string): Promise<string> {
  return launchStructuredAgentSession(worktreeId, 'codex')
}

export function launchStructuredClaudeSession(worktreeId: string): Promise<string> {
  return launchStructuredAgentSession(worktreeId, 'claude')
}

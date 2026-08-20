import { AGENT_INTERRUPT_SETTLE_MS } from './agent-interrupt-intent'
import type { AgentStatusState, AgentType } from './agent-status-types'

/** Same 500ms budget as settle — silence expires the hint; it never synthesizes `done`. */
export const AGENT_INTERRUPT_HINT_TTL_MS = AGENT_INTERRUPT_SETTLE_MS

const CHILD_LIFECYCLE_HOOK_EVENTS = new Set(['SubagentStart', 'SubagentStop', 'TeammateIdle'])

export type AgentInterruptHint = {
  paneKey: string
  prompt: string
  stateStartedAt: number
  agentType: AgentType | undefined
  recordedAt: number
}

function equivalentHintAgentType(
  actual: AgentType | undefined,
  baseline: AgentType | undefined
): boolean {
  const normalizedActual = actual === 'unknown' ? undefined : actual
  const normalizedBaseline = baseline === 'unknown' ? undefined : baseline
  return normalizedActual === normalizedBaseline
}

/** Claude/Kimi Stop already carry `is_interrupt`; absence of the flag is authoritative. */
export function isHookAuthoritativeInterruptAgent(agentType: AgentType | undefined): boolean {
  return agentType === 'claude' || agentType === 'openclaude' || agentType === 'kimi'
}

export type ReconcileAgentInterruptHintResult = {
  hint: AgentInterruptHint | undefined
  stampInterrupted: boolean
}

export function reconcileAgentInterruptHint({
  hint,
  now,
  incoming,
  previousStateStartedAt
}: {
  hint: AgentInterruptHint | undefined
  now: number
  incoming: {
    paneKey: string
    hookEventName?: string
    toolAgentId?: string
    payload: {
      state: AgentStatusState
      prompt: string
      agentType?: AgentType
      interrupted?: boolean
    }
  }
  previousStateStartedAt?: number
}): ReconcileAgentInterruptHintResult {
  if (!hint || hint.paneKey !== incoming.paneKey) {
    return { hint, stampInterrupted: false }
  }

  const sameTurn =
    hint.prompt === incoming.payload.prompt &&
    equivalentHintAgentType(hint.agentType, incoming.payload.agentType) &&
    (previousStateStartedAt === undefined || hint.stateStartedAt === previousStateStartedAt)

  if (!sameTurn) {
    return { hint: undefined, stampInterrupted: false }
  }

  const live = now - hint.recordedAt <= AGENT_INTERRUPT_HINT_TTL_MS
  if (
    incoming.payload.state === 'working' ||
    incoming.payload.state === 'waiting' ||
    incoming.payload.state === 'blocked'
  ) {
    return { hint: undefined, stampInterrupted: false }
  }
  if (incoming.payload.state !== 'done') {
    return { hint: live ? hint : undefined, stampInterrupted: false }
  }
  if (!live) {
    return { hint: undefined, stampInterrupted: false }
  }
  if (isHookAuthoritativeInterruptAgent(incoming.payload.agentType)) {
    return { hint: undefined, stampInterrupted: false }
  }
  if (incoming.toolAgentId || CHILD_LIFECYCLE_HOOK_EVENTS.has(incoming.hookEventName ?? '')) {
    return { hint, stampInterrupted: false }
  }
  return { hint: undefined, stampInterrupted: true }
}

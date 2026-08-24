import { agentProviderSessionsEqual } from '../agent-session-resume'
import type { AgentHookEventPayload } from './listener-event'

type ClaudeCompactIdentity = Pick<
  AgentHookEventPayload,
  | 'source'
  | 'connectionId'
  | 'hookEventName'
  | 'providerPromptId'
  | 'compactTrigger'
  | 'providerSession'
>

export function canAcceptClaudeCompactTransition(
  previous: AgentHookEventPayload | undefined,
  incoming: ClaudeCompactIdentity,
  options: { allowUnanchoredPreCompact?: boolean; allowUnanchoredPostCompact?: boolean } = {}
): boolean {
  if (
    incoming.source !== 'claude' ||
    incoming.compactTrigger === undefined ||
    incoming.providerPromptId === undefined ||
    (incoming.hookEventName !== 'PreCompact' && incoming.hookEventName !== 'PostCompact')
  ) {
    return false
  }
  if (incoming.hookEventName === 'PreCompact' && options.allowUnanchoredPreCompact) {
    return true
  }
  if (incoming.hookEventName === 'PostCompact' && options.allowUnanchoredPostCompact) {
    return true
  }
  if (
    previous?.source !== 'claude' ||
    previous.payload.agentType !== 'claude' ||
    previous.connectionId !== incoming.connectionId ||
    !agentProviderSessionsEqual('claude', previous.providerSession, incoming.providerSession)
  ) {
    return false
  }
  if (incoming.hookEventName === 'PostCompact') {
    return (
      previous.compactTrigger === incoming.compactTrigger &&
      previous.providerPromptId === incoming.providerPromptId
    )
  }
  return incoming.compactTrigger === 'manual'
    ? previous.providerPromptId !== undefined
    : previous.providerPromptId === incoming.providerPromptId
}

export function resolveCachedClaudeCompactOwnership(
  previous: AgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload
): AgentHookEventPayload {
  const sameClaudeOwner =
    previous?.source === 'claude' &&
    previous.payload.agentType === 'claude' &&
    incoming.source === 'claude' &&
    incoming.payload.agentType === 'claude' &&
    incoming.connectionId === previous.connectionId &&
    agentProviderSessionsEqual('claude', previous.providerSession, incoming.providerSession)
      ? previous
      : undefined
  if (incoming.hookEventName === 'PreCompact' && incoming.compactTrigger) {
    return sameClaudeOwner?.payload.prompt && incoming.payload.prompt.length === 0
      ? { ...incoming, payload: { ...incoming.payload, prompt: sameClaudeOwner.payload.prompt } }
      : incoming
  }
  if (incoming.hookEventName === 'PostCompact') {
    return incoming.compactTrigger ? { ...incoming, compactTrigger: undefined } : incoming
  }
  const ownsCompact =
    sameClaudeOwner?.compactTrigger !== undefined &&
    sameClaudeOwner.providerPromptId !== undefined &&
    incoming.providerPromptId === sameClaudeOwner.providerPromptId
  if (ownsCompact) {
    return {
      ...incoming,
      compactTrigger: sameClaudeOwner.compactTrigger,
      payload:
        incoming.payload.prompt.length === 0 && sameClaudeOwner.payload.prompt
          ? { ...incoming.payload, prompt: sameClaudeOwner.payload.prompt }
          : incoming.payload
    }
  }
  return incoming.compactTrigger ? { ...incoming, compactTrigger: undefined } : incoming
}

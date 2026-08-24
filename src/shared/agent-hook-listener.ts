import { normalizeAgentStatusPayload } from './agent-status-types'
import type { AgentHookSource } from './agent-hook-relay'
import { extractAgentProviderSession } from './agent-session-resume'
import { canAcceptClaudeCompactTransition } from './agent-hook-listener/claude-compact-ownership'
import { parseHookEnvelope } from './agent-hook-listener/hook-envelope'
import { readFirstString } from './agent-hook-listener/interactive-tool'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { normalizeClaudePromptId } from './agent-hook-listener/listener-limits'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import { extractPromptText } from './agent-hook-listener/prompt-fields'
import { normalizeProviderEvent } from './agent-hook-listener/provider-dispatch'
import { hasExplicitUserPrompt } from './agent-hook-listener/provider-event-routing'
import { hasExplicitAmpPrompt } from './agent-hook-listener/providers/amp-events'
import { readString } from './agent-hook-listener/tool-input-preview'
/** Canonical transport-agnostic normalization entry shared by main and relay listeners. */
export function normalizeHookPayload(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string,
  options: { allowUnanchoredPreCompact?: boolean; allowUnanchoredPostCompact?: boolean } = {}
): AgentHookEventPayload | null {
  const envelope = parseHookEnvelope(state, source, body, expectedEnv)
  if (!envelope) {
    return null
  }
  const { record, paneKey, hookPayloadRecord, tabId, worktreeId, launchToken } = envelope
  if (source === 'claude') {
    state.claudeUnconfirmedRestoredStatusPaneKeys.delete(paneKey)
  }
  const eventName =
    readFirstString(record, ['hook_event_name', 'hookEventName', 'hook_type', 'hookType']) ??
    hookPayloadRecord.hook_event_name ??
    hookPayloadRecord.hookEventName
  // Codex child hooks expose the child's session_id on the parent's pane.
  const providerSession =
    source === 'codex' && readString(hookPayloadRecord, 'agent_id')
      ? null
      : extractAgentProviderSession(source, hookPayloadRecord)
  const providerPromptId =
    source === 'claude' ? normalizeClaudePromptId(hookPayloadRecord.prompt_id) : undefined
  const compactTrigger =
    source === 'claude' &&
    (eventName === 'PreCompact' || eventName === 'PostCompact') &&
    (hookPayloadRecord.trigger === 'manual' || hookPayloadRecord.trigger === 'auto')
      ? hookPayloadRecord.trigger
      : undefined
  const isCompactEvent = eventName === 'PreCompact' || eventName === 'PostCompact'
  if (isCompactEvent && compactTrigger === undefined) {
    return null
  }
  const previousStatus = state.lastStatusByPaneKey.get(paneKey)
  if (
    compactTrigger !== undefined &&
    !canAcceptClaudeCompactTransition(
      previousStatus,
      {
        source,
        connectionId: null,
        hookEventName: typeof eventName === 'string' ? eventName : undefined,
        providerPromptId,
        compactTrigger,
        providerSession: providerSession ?? undefined
      },
      {
        allowUnanchoredPreCompact: options.allowUnanchoredPreCompact,
        allowUnanchoredPostCompact: options.allowUnanchoredPostCompact
      }
    )
  ) {
    return null
  }
  if (
    eventName === 'PostCompact' &&
    compactTrigger !== undefined &&
    previousStatus?.payload.prompt &&
    !state.lastPromptByPaneKey.has(paneKey)
  ) {
    state.lastPromptByPaneKey.set(paneKey, previousStatus.payload.prompt)
  }

  const extractedPrompt = extractPromptText(hookPayloadRecord)
  const promptText = extractedPrompt.text
  const dispatched = normalizeProviderEvent({
    state,
    source,
    eventName,
    promptText,
    paneKey,
    hookPayload: hookPayloadRecord,
    envelope: record,
    extractedPrompt
  })
  const providerSessionOnly =
    (source === 'pi' || source === 'prime-agent') &&
    eventName === 'session_start' &&
    providerSession !== null
  // A transcript session_start carries resume identity while idle; receivers discard the placeholder row.
  const transportPayload =
    dispatched.payload ??
    (providerSessionOnly
      ? normalizeAgentStatusPayload({ state: 'done', prompt: '', agentType: source })
      : null)
  const restoredUnconfirmed =
    source === 'claude' && state.claudeUnconfirmedRestoredStatusPaneKeys.delete(paneKey)
  if (!transportPayload) {
    return null
  }

  return {
    paneKey,
    source,
    launchToken,
    tabId,
    worktreeId,
    // Normalization is transport-agnostic; only ingestRemote knows the mux identity to stamp.
    connectionId: null,
    ...(restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
    hasExplicitPrompt:
      source === 'amp'
        ? hasExplicitAmpPrompt(eventName, promptText, hookPayloadRecord)
          ? true
          : undefined
        : hasExplicitUserPrompt(
            source,
            eventName,
            extractedPrompt,
            dispatched.resolvedPromptText,
            dispatched.hasTranscriptPromptEvidence
          ),
    promptInteractionKey: dispatched.promptInteractionKey,
    hookEventName: typeof eventName === 'string' ? eventName : undefined,
    providerPromptId,
    compactTrigger,
    toolUseId: readFirstString(hookPayloadRecord, ['tool_use_id', 'toolUseId']),
    toolAgentId: readFirstString(hookPayloadRecord, ['agent_id', 'agentId']),
    teammateName:
      source === 'claude' && eventName === 'TeammateIdle'
        ? readString(hookPayloadRecord, 'teammate_name')
        : undefined,
    toolAgentType: readString(hookPayloadRecord, 'agent_type'),
    ...(source === 'claude'
      ? {
          claudeRunningNonAgentTask:
            state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
            state.claudeActiveSessionCronPaneKeys.has(paneKey)
        }
      : {}),
    ...(providerSession ? { providerSession } : {}),
    ...(providerSessionOnly ? { providerSessionOnly: true } : {}),
    payload: transportPayload
  }
}

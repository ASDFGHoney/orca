import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { readClaudeBackgroundAgentTasks } from '../../claude-background-task-inventory'
import {
  claudeRosterHasRestoredSnapshotSubagent,
  claudeRosterHasRuntimeWorkingSubagent,
  foldClaudeBackgroundTasksIntoRoster,
  upsertWorkingClaudeSubagent
} from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { readFirstString } from '../interactive-tool'
import { shouldIgnoreCompactContinuationUserPromptSubmit } from '../prompt-fields'
import { readString } from '../tool-input-preview'
import {
  buildClaudeCachedLeadStatusPayload,
  normalizeClaudeSubagentLifecycleEvent
} from './claude-lifecycle-events'
import {
  getOrCreateClaudeSubagentRoster,
  resolveClaudePaneState,
  updateClaudeRunningNonAgentTask
} from './claude-roster-state'
import { buildClaudeStatusPayload } from './claude-status-build'

export function normalizeClaudeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const eventAgentId = readString(hookPayload, 'agent_id')
  if (
    eventName === 'SubagentStart' ||
    eventName === 'SubagentStop' ||
    eventName === 'TeammateIdle'
  ) {
    return normalizeClaudeSubagentLifecycleEvent(state, eventName, paneKey, hookPayload)
  }
  if (eventName === 'SessionStart') {
    // Why: SessionStart is the only signal a resumed session emits before its first prompt
    // (STA-3386). Land it as a session-boundary 'done' row: 'working' would show a phantom
    // spinner on an idle TUI (why Devin/Pi/Grok drop the event), and the sessionBoundary
    // flag keeps completion-reactive consumers (notifications, automation runs) out of it.
    const sessionStartSource = hookPayload['source']
    if (
      eventAgentId !== undefined ||
      (sessionStartSource !== 'startup' &&
        sessionStartSource !== 'resume' &&
        sessionStartSource !== 'clear')
    ) {
      // Why: allowlist idle boundaries and fail closed — a compact restart (or any unknown
      // source) fires mid-turn, and a child-attributed SessionStart must not flip the lead's
      // live turn to an idle row.
      return null
    }
    // Why: a new process owns the pane; stale children/tasks/crons must not gate the
    // fresh session's idle row back up to 'working' (same reset Codex does on SessionStart).
    state.claudeSubagentRosterByPaneKey.delete(paneKey)
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
    state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    state.claudeLeadStateByPaneKey.set(paneKey, { state: 'done' })
    return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
      stateName: 'done',
      updateToolSnapshot: true,
      sessionBoundary: true
    })
  }
  const previousLead = state.claudeLeadStateByPaneKey.get(paneKey)
  // Why: only a turn boundary may declare an interrupt or carry a prior one forward; any other event starts a fresh turn and drops it.
  const isTurnBoundary = eventName === 'Stop' || eventName === 'StopFailure'
  const interrupted =
    isTurnBoundary &&
    ((eventAgentId === undefined && hookPayload['is_interrupt'] === true) ||
      previousLead?.interrupted === true)
      ? true
      : undefined
  const backgroundTasks = readClaudeBackgroundAgentTasks(hookPayload)
  const sessionCrons = hookPayload['session_crons']
  const sessionCronInventoryPresent = Array.isArray(sessionCrons)
  const hasActiveSessionCron = sessionCronInventoryPresent && sessionCrons.length > 0

  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  // Why: Claude normally emits PreToolUse while AskUserQuestion is blocked; newer builds can also report it as PermissionRequest.
  // Treat the PreToolUse as waiting so the sidebar shows amber attention, not a spinner that decays to grey. Mirrors normalizeKimiEvent.
  const eventToolName = readString(hookPayload, 'tool_name')
  const isAskUserQuestionWait =
    (eventName === 'PreToolUse' || eventName === 'PermissionRequest') &&
    isAskUserQuestionTool(eventToolName)
  const isAskUserQuestion = eventName === 'PreToolUse' && isAskUserQuestionWait
  // Why: /compact can take minutes and does not emit Stop. PreCompact marks the pane busy;
  // PostCompact clears it so a finished compact cannot leave a sticky working spinner (#11352).
  const reportedStateName =
    eventName === 'UserPromptSubmit' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure' ||
    eventName === 'PreCompact' ||
    (eventName === 'PostCompact' && hookPayload.trigger === 'auto') ||
    (eventName === 'PreToolUse' && !isAskUserQuestion)
      ? 'working'
      : eventName === 'PermissionRequest' || isAskUserQuestion
        ? 'waiting'
        : isTurnBoundary || (eventName === 'PostCompact' && hookPayload.trigger === 'manual')
          ? 'done'
          : null

  if (!reportedStateName) {
    return null
  }
  if (backgroundTasks.present && eventAgentId === undefined) {
    updateClaudeRunningNonAgentTask(
      state,
      paneKey,
      backgroundTasks.hasRunningNonAgentTask,
      interrupted === true
    )
  }
  if (sessionCronInventoryPresent && eventAgentId === undefined) {
    if (hasActiveSessionCron && interrupted !== true) {
      state.claudeActiveSessionCronPaneKeys.add(paneKey)
    } else {
      state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    }
  } else if (eventAgentId === undefined && isTurnBoundary && backgroundTasks.present) {
    // Why: current Claude may omit an empty cron inventory while still emitting background_tasks.
    state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  }

  const eventToolUseId = readFirstString(hookPayload, ['tool_use_id', 'toolUseId'])
  const previousTool = state.lastToolByPaneKey.get(paneKey)
  const isParallelSiblingCompletionDuringQuestion =
    eventAgentId === undefined &&
    previousLead?.state === 'waiting' &&
    isAskUserQuestionTool(previousTool?.toolName) &&
    (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') &&
    previousLead.waitingToolUseId !== undefined &&
    eventToolUseId !== undefined &&
    eventToolUseId !== previousLead.waitingToolUseId
  if (isParallelSiblingCompletionDuringQuestion) {
    return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload)
  }

  // Why: subagent/teammate events carry `agent_id` (lead's don't); child tool activity keeps its row live but must not become the lead's state or overwrite its tool/prompt caches (a live card would vanish).
  // Two exceptions take the full path below: waiting-inducing events (a child needs human attention on this pane) and the blocked child's own next tool event (approval granted — clear the wait as for the lead).
  const isWaitingInducing = reportedStateName === 'waiting'
  const subagentOriginId =
    !isWaitingInducing &&
    (eventName === 'PreToolUse' ||
      eventName === 'PostToolUse' ||
      eventName === 'PostToolUseFailure')
      ? eventAgentId
      : undefined
  if (eventAgentId && (subagentOriginId || isWaitingInducing)) {
    upsertWorkingClaudeSubagent(
      getOrCreateClaudeSubagentRoster(state, paneKey),
      eventAgentId,
      { agentType: readString(hookPayload, 'agent_type') },
      Date.now()
    )
  }
  if (subagentOriginId) {
    const lead = state.claudeLeadStateByPaneKey.get(paneKey)
    if (lead?.state !== 'waiting' || lead.waitingAgentId !== subagentOriginId) {
      return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload, {
        workingChildEvidence: true
      })
    }
    const isParallelSiblingCompletionDuringChildQuestion =
      (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') &&
      lead.waitingToolUseId !== undefined &&
      eventToolUseId !== undefined &&
      eventToolUseId !== lead.waitingToolUseId
    if (isParallelSiblingCompletionDuringChildQuestion) {
      return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload, {
        workingChildEvidence: true
      })
    }
    // Why: approval granted — update the tool snapshot (drop the pending card) as the lead's own next tool event would.
    // Restore the stashed lead state, not this child's 'working': the lead may already be done, and the done-gate never upgrades working back to done once the roster drains.
    const restored = lead.stateBeforeWait ?? { state: 'working' as const }
    state.claudeLeadStateByPaneKey.set(paneKey, restored)
    return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
      stateName: resolveClaudePaneState(state, paneKey, restored),
      updateToolSnapshot: true,
      interrupted: restored.interrupted,
      turnCompletedAt: restored.turnCompletedAt
    })
  }

  // Why: lead events never carry agent_id; even a child missed by lifecycle tracking cannot own the lead turn or its background-work evidence.
  if (eventAgentId && !isWaitingInducing) {
    return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload, {
      workingChildEvidence: claudeRosterHasRuntimeWorkingSubagent(
        state.claudeSubagentRosterByPaneKey.get(paneKey)
      )
    })
  }

  if (isTurnBoundary && eventAgentId === undefined) {
    // Why: background_tasks is trusted only where unambiguous (see foldClaudeBackgroundTasksIntoRoster) — teammates report "running" here even while idle.
    // Older Claude builds without the field keep the incrementally tracked roster.
    if (backgroundTasks.present) {
      foldClaudeBackgroundTasksIntoRoster(
        getOrCreateClaudeSubagentRoster(state, paneKey),
        backgroundTasks.tasks,
        Date.now(),
        { inventoryComplete: !backgroundTasks.truncated }
      )
    }
  }
  // Why: a child-induced wait displaces the lead state; stash it so clearing restores reality (lead may be done). A 2nd child wait carries the ORIGINAL stash, not the intermediate waiting state.
  const stateBeforeWait =
    isWaitingInducing && eventAgentId && previousLead
      ? previousLead.state === 'waiting'
        ? previousLead.stateBeforeWait
        : {
            state: previousLead.state,
            ...(previousLead.interrupted ? { interrupted: true as const } : {}),
            // Why: a child's permission pause displaces an already-finished lead; keep the end time so the later drain is still that turn's tail.
            ...(previousLead.turnCompletedAt !== undefined
              ? { turnCompletedAt: previousLead.turnCompletedAt }
              : {})
          }
      : undefined
  const waitingToolUseId = eventToolUseId ?? previousLead?.waitingToolUseId

  if (interrupted && eventAgentId === undefined) {
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
    state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  }

  const effectiveState = resolveClaudePaneState(state, paneKey, {
    state: reportedStateName,
    interrupted
  })
  // Why: the lead already ended — the pane stays `working` only because background inventory is still registered. `stateStartedAt` is pinned for that whole run, so this end time is the per-turn identity and the later all-clear's pair key.
  const turnCompletedAt =
    eventAgentId === undefined &&
    isTurnBoundary &&
    reportedStateName === 'done' &&
    effectiveState === 'working' &&
    interrupted !== true
      ? Date.now()
      : undefined

  state.claudeLeadStateByPaneKey.set(paneKey, {
    state: reportedStateName,
    ...(interrupted ? { interrupted } : {}),
    ...(isWaitingInducing && eventAgentId ? { waitingAgentId: eventAgentId } : {}),
    ...(isAskUserQuestionWait && waitingToolUseId !== undefined ? { waitingToolUseId } : {}),
    ...(stateBeforeWait ? { stateBeforeWait } : {}),
    ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {})
  })

  const effectiveRoster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (
    isTurnBoundary &&
    eventAgentId === undefined &&
    effectiveState === 'working' &&
    claudeRosterHasRestoredSnapshotSubagent(effectiveRoster) &&
    !claudeRosterHasRuntimeWorkingSubagent(effectiveRoster) &&
    !state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) &&
    !state.claudeActiveSessionCronPaneKeys.has(paneKey)
  ) {
    // Why: a legacy or partial Stop confirms the lead boundary, not a child restored from disk; keep the child-only gate eligible for reconciliation.
    state.claudeUnconfirmedRestoredStatusPaneKeys.add(paneKey)
  }

  return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
    stateName: effectiveState,
    updateToolSnapshot: true,
    interrupted,
    turnCompletedAt
  })
}

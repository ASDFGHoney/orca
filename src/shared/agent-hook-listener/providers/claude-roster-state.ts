import type { AgentStatusState, AgentSubagentSnapshot } from '../../agent-status-types'
import {
  claudeRosterHasWorkingSubagent,
  reapUnconfirmedRestoredClaudeSubagents,
  type ClaudeSubagentRoster
} from '../../claude-subagent-roster'
import type { AgentHookEventPayload } from '../listener-event'
import type { ClaudeLeadTurnState, HookListenerState } from '../listener-state'

export function getOrCreateClaudeSubagentRoster(
  state: HookListenerState,
  paneKey: string
): ClaudeSubagentRoster {
  let roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.claudeSubagentRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

export function updateClaudeRunningNonAgentTask(
  state: HookListenerState,
  paneKey: string,
  hasRunningNonAgentTask: boolean,
  interrupted: boolean
): void {
  if (hasRunningNonAgentTask && !interrupted) {
    state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
  } else {
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
}

export function resolveClaudePaneState(
  state: HookListenerState,
  paneKey: string,
  lead: Pick<ClaudeLeadTurnState, 'state' | 'interrupted'>
): AgentStatusState {
  if (lead.state !== 'done') {
    return lead.state
  }
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  return claudeRosterHasWorkingSubagent(roster) ||
    (!lead.interrupted &&
      (state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
        state.claudeActiveSessionCronPaneKeys.has(paneKey)))
    ? 'working'
    : 'done'
}
/** Sync the Claude lead-turn record when the SERVER infers an interrupt outside the hook stream (Ctrl+C with a missed Stop); else a later child lifecycle event resurrects the cancelled pane. */
export function markClaudeLeadTurnInterrupted(state: HookListenerState, paneKey: string): void {
  state.claudeLeadStateByPaneKey.set(paneKey, { state: 'done', interrupted: true })
  state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
}

/** Rebuild a pane's working roster from a persisted snapshot; live activity confirms a seed, a complete task inventory may reap an unconfirmed one whose finish hook arrived while Orca was offline. */
export function seedClaudeSubagentRosterFromSnapshots(
  state: HookListenerState,
  paneKey: string,
  snapshots: readonly AgentSubagentSnapshot[]
): void {
  if (snapshots.length === 0 || state.claudeSubagentRosterByPaneKey.has(paneKey)) {
    return
  }
  const roster = getOrCreateClaudeSubagentRoster(state, paneKey)
  for (const snapshot of snapshots) {
    // Why: idle-teammate liveness can't be proven across a restart (its TeammateIdle confirmation is gone); only working seeds restore, and a live teammate re-earns its row via SubagentStart.
    if (snapshot.state !== 'working') {
      continue
    }
    roster.set(snapshot.id, {
      state: 'working',
      startedAt: snapshot.startedAt,
      agentType: snapshot.agentType,
      description: snapshot.description,
      // Why: the seed can be a phantom (child finished while Orca was down, SubagentStop lost); let a PRESENT background_tasks list omitting the id remove it, not gate the pane 'working' forever.
      backgroundTasksAuthoritative: true,
      // Why: an idle parent never emits that list, so the inventory reap alone can strand the seed; mark it for the liveness reap below.
      restoredFromSnapshot: true
    })
  }
}

export function seedClaudeLeadTurnFromPersistedStatus(
  state: HookListenerState,
  paneKey: string,
  status: Pick<AgentHookEventPayload, 'payload'>,
  options: { childOnlyBoundary: boolean }
): void {
  if (options.childOnlyBoundary && status.payload.agentType === 'claude') {
    state.claudeLeadStateByPaneKey.set(paneKey, {
      state: 'done',
      ...(status.payload.interrupted === true ? { interrupted: true } : {}),
      ...(status.payload.turnCompletedAt !== undefined
        ? { turnCompletedAt: status.payload.turnCompletedAt }
        : {})
    })
    if (status.payload.prompt) {
      state.lastPromptByPaneKey.set(paneKey, status.payload.prompt)
    }
    if (status.payload.lastAssistantMessage) {
      state.lastToolByPaneKey.set(paneKey, {
        lastAssistantMessage: status.payload.lastAssistantMessage
      })
    }
  }
}

/** Reap this pane's unconfirmed restored seeds because no live agent process backs
 *  the pane any more (its PTY died while Orca was down, so no finish hook could
 *  arrive). Callers must have proven the pane is LOCAL-launched — a remote/SSH
 *  agent runs on the far host and can never appear in a local process index.
 *  Returns whether the roster changed. */
export function reapRestoredClaudeSubagentsForDeadPane(
  state: HookListenerState,
  paneKey: string
): boolean {
  const roster = state.claudeSubagentRosterByPaneKey.get(paneKey)
  if (!roster || !reapUnconfirmedRestoredClaudeSubagents(roster)) {
    return false
  }
  if (roster.size === 0) {
    state.claudeSubagentRosterByPaneKey.delete(paneKey)
  }
  return true
}

/** Drop a child-owned waiting state when the child stops/idles, restoring the displaced lead state. */
export function clearClaudePendingWaitForAgent(
  state: HookListenerState,
  paneKey: string,
  ownsWait: (waitingAgentId: string) => boolean
): void {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  if (lead?.state !== 'waiting' || !lead.waitingAgentId || !ownsWait(lead.waitingAgentId)) {
    return
  }
  state.claudeLeadStateByPaneKey.set(paneKey, lead.stateBeforeWait ?? { state: 'working' })
  const previousTool = state.lastToolByPaneKey.get(paneKey)
  state.lastToolByPaneKey.set(
    paneKey,
    previousTool?.lastAssistantMessage
      ? { lastAssistantMessage: previousTool.lastAssistantMessage }
      : {}
  )
}

/** Clear an AskUserQuestion wait after the answer is typed (answering emits no hook event; the caller infers it from the submit keystroke). Restores the stashed pre-wait lead state or 'working', drops the cached card, and returns the pane state to emit (gated up to 'working' while children run). */
export function clearClaudeAnsweredQuestionWait(
  state: HookListenerState,
  paneKey: string
): Pick<ClaudeLeadTurnState, 'state' | 'interrupted' | 'turnCompletedAt'> {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const restored =
    lead?.state === 'waiting'
      ? (lead.stateBeforeWait ?? { state: 'working' as const })
      : { state: 'working' as const }
  state.claudeLeadStateByPaneKey.set(paneKey, { ...restored })
  const previousTool = state.lastToolByPaneKey.get(paneKey)
  state.lastToolByPaneKey.set(
    paneKey,
    previousTool?.lastAssistantMessage
      ? { lastAssistantMessage: previousTool.lastAssistantMessage }
      : {}
  )
  const effectiveState = resolveClaudePaneState(state, paneKey, restored)
  return effectiveState === restored.state
    ? restored
    : {
        state: effectiveState,
        ...(restored.interrupted ? { interrupted: true as const } : {}),
        ...(restored.turnCompletedAt !== undefined
          ? { turnCompletedAt: restored.turnCompletedAt }
          : {})
      }
}

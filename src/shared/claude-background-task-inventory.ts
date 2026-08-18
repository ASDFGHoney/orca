import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'

const CLAUDE_TERMINAL_BACKGROUND_TASK_STATUSES = new Set([
  'idle',
  'done',
  'success',
  'succeeded',
  'complete',
  'completed',
  'finished',
  'failed',
  'error',
  'terminated',
  'exited',
  'aborted',
  'expired',
  'skipped',
  'crashed',
  'killed',
  'cancelled',
  'canceled',
  'timed_out'
])

/** Types Claude uses for a plain provider-owned background shell. Only a type on
 *  this list is positively identified as "not agent work" and therefore allowed to
 *  stop gating the pane; anything else fails active. Keep it a whitelist — an
 *  unrecognised type must never be assumed harmless (STA-4119). */
const CLAUDE_NON_AGENT_SHELL_TASK_TYPES = new Set(['shell', 'background_shell'])

/** One agent entry from the `background_tasks` array Claude attaches to Stop
 *  (and SubagentStop) hook payloads. Non-agent tasks do not become rows. */
export type ClaudeBackgroundAgentTask = {
  id: string
  agentType?: string
  description?: string
  running: boolean
  /** True for `type: "teammate"` entries. Their ids never match lifecycle
   *  agent_ids and they report "running" permanently — even after the named
   *  agent finished — so they carry no per-agent state at all. */
  teammate: boolean
}

/** Read the agent-typed entries of a hook payload's `background_tasks` field.
 *  `present: false` means the field was absent/malformed (older Claude builds),
 *  so callers must keep their tracked roster instead of clearing it. */
export function readClaudeBackgroundAgentTasks(hookPayload: Record<string, unknown>): {
  present: boolean
  tasks: ClaudeBackgroundAgentTask[]
  truncated: boolean
  /** Any running entry that is not an agent row: a positively identified shell OR
   *  something unclassifiable. Consumers that must not destroy live provider work
   *  (pane hibernation) use this broad signal. */
  hasRunningNonAgentTask: boolean
  /** The subset that could NOT be positively identified as a non-agent shell:
   *  unknown/future types, a blank or absent type, a malformed entry. This is the
   *  fail-active signal — it may still be agent work, so it keeps gating the pane
   *  at `working`. A recognised shell is deliberately absent from it. */
  hasRunningUnclassifiedTask: boolean
} {
  const raw = hookPayload['background_tasks']
  if (!Array.isArray(raw)) {
    return {
      present: false,
      tasks: [],
      truncated: false,
      hasRunningNonAgentTask: false,
      hasRunningUnclassifiedTask: false
    }
  }
  const tasks: ClaudeBackgroundAgentTask[] = []
  let truncated = false
  let hasRunningNonAgentTask = false
  let hasRunningUnclassifiedTask = false
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      truncated = true
      hasRunningNonAgentTask = true
      hasRunningUnclassifiedTask = true
      continue
    }
    const obj = item as Record<string, unknown>
    const taskType = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : ''
    const taskStatus = typeof obj.status === 'string' ? obj.status.trim().toLowerCase() : ''
    const isTerminal =
      taskStatus.length > 0 && CLAUDE_TERMINAL_BACKGROUND_TASK_STATUSES.has(taskStatus)
    if (taskType.length === 0) {
      truncated = true
      hasRunningNonAgentTask ||= !isTerminal
      hasRunningUnclassifiedTask ||= !isTerminal
      continue
    }
    const isAgentTask = taskType === 'subagent' || taskType === 'teammate'
    // Why: future non-agent types and nonterminal labels must fail active; only typed agent rows or explicit terminal states can safely retire work.
    if (!isAgentTask && !isTerminal) {
      hasRunningNonAgentTask = true
      // Why: a recognised shell is the ONE case we can prove is not agent work, so
      // only it may stop gating the pane. Everything else — `type: "agent"`, a type
      // Orca has never seen — stays unclassified and keeps the pane `working`.
      hasRunningUnclassifiedTask ||= !CLAUDE_NON_AGENT_SHELL_TASK_TYPES.has(taskType)
    }
    if (!isAgentTask) {
      continue
    }
    if (typeof obj.id !== 'string' || obj.id.trim().length === 0) {
      truncated = true
      continue
    }
    if (tasks.length >= AGENT_STATUS_MAX_SUBAGENTS) {
      // Why: a capped inventory cannot prove a tracked id is absent; callers
      // must retain unlisted rows rather than deleting live overflow tasks.
      truncated = true
      continue
    }
    tasks.push({
      id: obj.id.trim(),
      agentType: typeof obj.agent_type === 'string' ? obj.agent_type : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      running: !isTerminal,
      teammate: taskType === 'teammate'
    })
  }
  return { present: true, tasks, truncated, hasRunningNonAgentTask, hasRunningUnclassifiedTask }
}

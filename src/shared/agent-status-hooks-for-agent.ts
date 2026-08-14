// Why: launch surfaces need one answer to "are Orca's managed status hooks on
// for this agent" — the global toggle and the per-agent opt-out both count, and
// a surface that checks only one of them plans the wrong launch (#11941).

import { normalizeDisabledTuiAgents } from './tui-agent-selection'
import type { TuiAgent } from './tui-agent'

export function areAgentStatusHooksEnabledForAgent(
  settings:
    | { agentStatusHooksEnabled?: boolean; disabledTuiAgents?: readonly string[] }
    | null
    | undefined,
  agent: TuiAgent
): boolean {
  if (settings?.agentStatusHooksEnabled === false) {
    return false
  }
  return !normalizeDisabledTuiAgents(settings?.disabledTuiAgents).includes(agent)
}

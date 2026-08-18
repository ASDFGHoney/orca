import type { AgentStatusEntry } from '../../../shared/agent-status-types'

/** Providers that report a background-work inventory. For anything else Orca collects no such
 *  evidence, so requiring it would disable hibernation on the basis of a signal that never exists. */
const BACKGROUND_WORK_REPORTING_AGENT_TYPES = new Set(['claude'])

/**
 * Whether provider-owned background work should hold this pane awake.
 *
 * Tri-state, and the absent case is the one that matters: `true` is live work, `false` is
 * positively-none, and ABSENT means the provider has not told us in this runtime — after a restart,
 * or before the first inventory. Requiring `false` rather than rejecting only `true` is what stops
 * "we were never told" from reading as permission to destroy the PTY and whatever it is running
 * (STA-4119).
 */
export function providerBackgroundWorkBlocksHibernation(entry: AgentStatusEntry): boolean {
  if (!entry.agentType || !BACKGROUND_WORK_REPORTING_AGENT_TYPES.has(entry.agentType)) {
    return false
  }
  return entry.providerBackgroundWorkActive !== false
}

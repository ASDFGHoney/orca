import type { TuiAgent } from './tui-agent'

/**
 * One place that answers "which agent is in this pane".
 *
 * Today four ladders answer it independently — the tab icon, the open-tab/search occupant, the
 * sidebar title rows, and the sidebar hook-row fallback — and they disagree. Two of them consult
 * the terminal title before the launch record, so a string Orca parsed outranks a fact Orca owns.
 *
 * Two rules make this resolvable where reordering alone could not:
 *
 * 1. Evidence is ranked by how directly it observes the process, and a display title is last.
 * 2. Every observation carries the `runId` of the agent run it belongs to. Evidence from a run
 *    that has since been replaced is INELIGIBLE rather than merely outranked.
 *
 * Rule 2 is what separates two situations that are otherwise identical. A completed hook naming
 * A plus a title naming B is either a bug (the hook is right, the title is stale) or a legitimate
 * reclaim (the pane was reused and B really is there). Same signals, opposite answers. With run
 * ids they are different facts: in the bug both belong to the current run, and in the reclaim the
 * hook belongs to a previous one.
 *
 * A run is advanced only on positive evidence that a new agent started in the pane — an accepted
 * launch, a recognized command at a shell prompt, a host-confirmed foreground change, a new
 * provider session. Never by a title changing, and never by transport loss.
 */
export const PANE_AGENT_EVIDENCE_SOURCES = [
  /** A live provider hook for a turn in progress. The agent is running and said so. */
  'live-hook',
  /** The pane's foreground process, as read on the execution host. */
  'process',
  /** Orca launched, resumed, or accepted a command for this agent. A fact Orca owns. */
  'launch',
  /** A provider hook from a turn that finished. Still authoritative about identity. */
  'completed-hook',
  /** A sleeping session record restored for this pane. */
  'sleeping-session',
  /** Another pane in the same tab. Tab-level surfaces only; never pane-scoped routing. */
  'sibling',
  /** Parsed from the terminal title. A decoration channel; anyone can type an agent's name. */
  'title'
] as const
export type PaneAgentEvidenceSource = (typeof PANE_AGENT_EVIDENCE_SOURCES)[number]

/** Authority order, strongest first. Position here is the ONLY place precedence is expressed. */
const SOURCE_RANK: readonly PaneAgentEvidenceSource[] = PANE_AGENT_EVIDENCE_SOURCES

export type PaneAgentEvidence = {
  source: PaneAgentEvidenceSource
  agent: TuiAgent
  /**
   * The agent run this evidence describes. Evidence whose run is not the pane's current run is
   * ineligible. Undefined means unknown — from an old peer that does not publish run ids, or an
   * ingress not yet stamped — and is treated as eligible, so a missing field never blanks a row.
   */
  runId?: number
}

export type PaneAgentIdentityInput = {
  evidence: readonly PaneAgentEvidence[]
  /** The pane's current run. Undefined disables run filtering entirely (old peer, mixed version). */
  currentRunId?: number
  /**
   * Pane-scoped consumers must not inherit another pane's agent. Sibling evidence is dropped
   * unless the caller is a tab-level surface that opted in.
   */
  allowSibling?: boolean
}

export type PaneAgentIdentity = {
  agent: TuiAgent | null
  /** Which class of evidence decided it. Null when nothing eligible remained. */
  source: PaneAgentEvidenceSource | null
  /** Evidence discarded because it belongs to a superseded run. Surfaced for diagnostics. */
  supersededSources: readonly PaneAgentEvidenceSource[]
}

/**
 * Resolves one pane's agent from ranked evidence.
 *
 * Returns null rather than guessing. A pane with no eligible evidence shows no agent, which is
 * recoverable; showing the wrong agent is not, and at the action surfaces (orchestration routing,
 * mailbox delivery, prompt-cache timers) it is a misdelivery rather than a cosmetic slip.
 */
export function resolvePaneAgentIdentity(input: PaneAgentIdentityInput): PaneAgentIdentity {
  const superseded: PaneAgentEvidenceSource[] = []
  const eligible = input.evidence.filter((item) => {
    if (item.source === 'sibling' && input.allowSibling !== true) {
      return false
    }
    // Why undefined is eligible: absence means "this peer does not publish run ids", not "this
    // belongs to an old run". Treating unknown as stale would blank every row from an old host.
    if (input.currentRunId === undefined || item.runId === undefined) {
      return true
    }
    if (item.runId === input.currentRunId) {
      return true
    }
    superseded.push(item.source)
    return false
  })

  for (const source of SOURCE_RANK) {
    const match = eligible.find((item) => item.source === source)
    if (match) {
      return { agent: match.agent, source, supersededSources: superseded }
    }
  }
  return { agent: null, source: null, supersededSources: superseded }
}

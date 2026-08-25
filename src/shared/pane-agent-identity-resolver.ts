import type { AgentStatusObservation } from './agent-status-observation'
import type { TuiAgent } from './tui-agent'

export const PANE_AGENT_DISPLAY_POLICIES = {
  'focused-pane': ['live-hook', 'process', 'launch', 'completed-hook', 'sleeping-session', 'title'],
  'tab-aggregate': [
    'live-hook',
    'process',
    'launch',
    'completed-hook',
    'sleeping-session',
    'title',
    'sibling'
  ]
} as const

export type PaneAgentDisplayPolicy = keyof typeof PANE_AGENT_DISPLAY_POLICIES
export type PaneAgentEvidenceSource =
  (typeof PANE_AGENT_DISPLAY_POLICIES)[PaneAgentDisplayPolicy][number]

/** Execution-host-owned identity of one agent run behind a pane key. */
export type PaneAgentRun = {
  hostAuthorityId: string
  generation: number
}

/** Comparable only when both observations carry the same authority id. */
export type PaneAgentEvidenceOrder = Readonly<
  Pick<AgentStatusObservation, 'authorityId' | 'revision'>
>

export type PaneAgentEvidence = {
  source: PaneAgentEvidenceSource
  agent: TuiAgent
  /** Absent when an older peer or unstamped ingress cannot identify the agent run. */
  run?: PaneAgentRun
  /** Used only to settle equal-source claims that one authority sequenced. */
  order?: PaneAgentEvidenceOrder
}

export type PaneAgentDisplayIdentityInput = {
  policy: PaneAgentDisplayPolicy
  evidence: readonly PaneAgentEvidence[]
  /** Absent on older peers; display resolution then preserves compatibility. */
  currentRun?: PaneAgentRun
}

export type ResolvedPaneAgentDisplayIdentity = {
  kind: 'resolved'
  agent: TuiAgent
  source: PaneAgentEvidenceSource
  /** Compatibility means one side cannot publish agent-run identity. */
  runScope: 'current' | 'compatibility'
}

export type UnresolvedPaneAgentDisplayIdentity = {
  kind: 'unresolved'
  reason: 'no-evidence' | 'run-transition' | 'conflicting-evidence'
  /** Present when equally ranked, incomparable evidence names different agents. */
  source?: PaneAgentEvidenceSource
}

export type PaneAgentDisplayIdentity =
  | ResolvedPaneAgentDisplayIdentity
  | UnresolvedPaneAgentDisplayIdentity

/**
 * Display-only identity resolution. Write authorization requires proof-bearing process, hook, or
 * launch capabilities and deliberately has no resolver in this module.
 */
export function resolvePaneAgentDisplayIdentity(
  input: PaneAgentDisplayIdentityInput
): PaneAgentDisplayIdentity {
  const sources = PANE_AGENT_DISPLAY_POLICIES[input.policy]
  let rejectedSupersededRun = false

  for (const source of sources) {
    const eligible: PaneAgentEvidence[] = []
    for (const item of input.evidence) {
      if (item.source !== source) {
        continue
      }
      if (isSupersededRun(item.run, input.currentRun)) {
        rejectedSupersededRun = true
        continue
      }
      eligible.push(item)
    }
    if (eligible.length === 0) {
      continue
    }

    const exactCurrent = eligible.filter((item) => isSameRun(item.run, input.currentRun))
    const candidates = exactCurrent.length > 0 ? exactCurrent : eligible
    const selected = selectEqualSourceCandidate(candidates)
    if (selected === null) {
      return { kind: 'unresolved', reason: 'conflicting-evidence', source }
    }
    return {
      kind: 'resolved',
      agent: selected.agent,
      source,
      runScope: isSameRun(selected.run, input.currentRun) ? 'current' : 'compatibility'
    }
  }

  return {
    kind: 'unresolved',
    reason: rejectedSupersededRun ? 'run-transition' : 'no-evidence'
  }
}

function selectEqualSourceCandidate(
  candidates: readonly PaneAgentEvidence[]
): PaneAgentEvidence | null {
  const first = candidates[0]
  if (candidates.every((item) => item.agent === first.agent)) {
    return first
  }

  const firstOrder = first.order
  if (
    firstOrder === undefined ||
    candidates.some(
      (item) => item.order === undefined || item.order.authorityId !== firstOrder.authorityId
    )
  ) {
    return null
  }

  let newest = first
  for (const candidate of candidates.slice(1)) {
    if (
      candidate.order !== undefined &&
      newest.order !== undefined &&
      candidate.order.revision > newest.order.revision
    ) {
      newest = candidate
    }
  }
  if (newest.order === undefined) {
    return null
  }
  const sameRevision = candidates.filter((item) => item.order?.revision === newest.order?.revision)
  return sameRevision.every((item) => item.agent === newest.agent) ? newest : null
}

function isSupersededRun(
  evidenceRun: PaneAgentRun | undefined,
  currentRun: PaneAgentRun | undefined
): boolean {
  return (
    evidenceRun !== undefined && currentRun !== undefined && !isSameRun(evidenceRun, currentRun)
  )
}

function isSameRun(left: PaneAgentRun | undefined, right: PaneAgentRun | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.hostAuthorityId === right.hostAuthorityId &&
    left.generation === right.generation
  )
}

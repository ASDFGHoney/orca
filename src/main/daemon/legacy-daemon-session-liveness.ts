import { isShellProcess } from '../../shared/shell-process-detection'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

export type SessionActivityVerdict =
  | { status: 'live'; sessionId: string; reason: string }
  | { status: 'idle'; sessionId: string; reason: string }
  | { status: 'unverifiable'; sessionId: string; reason: string }

export type GenerationRetirementDecision =
  | { action: 'retire'; reason: 'all-sessions-idle' }
  | { action: 'keep'; reason: 'live-session'; liveSessionIds: string[] }
  | {
      action: 'keep'
      reason: 'unverifiable'
      unverifiableSessionIds: string[]
      leak: string
    }

export type SessionActivityEvidence = {
  sessionId: string
  agentSessionOwners?: readonly unknown[] | null
  inspection: PtyProcessInspection | { failed: true; reason: string }
}

export function classifyLegacyDaemonSessionActivity(
  evidence: SessionActivityEvidence
): SessionActivityVerdict {
  const { sessionId } = evidence
  if ('failed' in evidence.inspection) {
    return { status: 'unverifiable', sessionId, reason: evidence.inspection.reason }
  }
  const inspection = evidence.inspection
  if (inspection.unavailable) {
    return {
      status: 'unverifiable',
      sessionId,
      reason: 'process inspection unavailable'
    }
  }
  if ((evidence.agentSessionOwners?.length ?? 0) > 0) {
    return { status: 'live', sessionId, reason: 'attached live agent' }
  }
  if (inspection.hasChildProcesses) {
    return { status: 'live', sessionId, reason: 'session has child processes' }
  }
  if (
    inspection.foregroundProcess != null &&
    inspection.foregroundProcess !== '' &&
    !isShellProcess(inspection.foregroundProcess)
  ) {
    return { status: 'live', sessionId, reason: 'non-shell foreground process' }
  }
  return {
    status: 'idle',
    sessionId,
    reason: 'no agent, no children, shell or empty foreground'
  }
}

export function decideLegacyDaemonGenerationRetirement(
  verdicts: readonly SessionActivityVerdict[]
): GenerationRetirementDecision {
  const unverifiable = verdicts.filter((verdict) => verdict.status === 'unverifiable')
  if (unverifiable.length > 0) {
    const unverifiableSessionIds = unverifiable.map((verdict) => verdict.sessionId)
    return {
      action: 'keep',
      reason: 'unverifiable',
      unverifiableSessionIds,
      leak: `liveness unverifiable for ${unverifiableSessionIds.join(', ')}`
    }
  }
  const live = verdicts.filter((verdict) => verdict.status === 'live')
  if (live.length > 0) {
    return {
      action: 'keep',
      reason: 'live-session',
      liveSessionIds: live.map((verdict) => verdict.sessionId)
    }
  }
  return { action: 'retire', reason: 'all-sessions-idle' }
}

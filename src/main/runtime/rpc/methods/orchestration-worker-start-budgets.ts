import {
  ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS,
  ORCHESTRATION_READINESS_TIMEOUT_MS,
  resolveFederationAttachDeadlineMs,
  resolveWorkerStartClientTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'

export function resolveFederatedWorkerStartBudgets(
  timeoutMs: number | undefined,
  nowMs = Date.now()
) {
  const readinessTimeoutMs = timeoutMs ?? ORCHESTRATION_READINESS_TIMEOUT_MS
  const outerDeadlineMs = nowMs + resolveWorkerStartClientTimeoutMs(readinessTimeoutMs)
  return {
    readinessTimeoutMs,
    outerDeadlineMs,
    preflightTimeoutMs: ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS,
    attachDeadlineMs: resolveFederationAttachDeadlineMs({
      readinessTimeoutMs,
      outerDeadlineMs,
      nowMs
    })
  }
}

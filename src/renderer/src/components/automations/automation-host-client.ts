import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { StableAutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import { parseExecutionHostId } from '../../../../shared/execution-host'

export type AutomationHostTarget =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string }

export function getAutomationHostTargetKey(target: AutomationHostTarget): string {
  return target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'
}

export function getAutomationHostTargetFromKey(key: string | null): AutomationHostTarget | null {
  if (!key) {
    return null
  }
  if (key.startsWith('environment:')) {
    return { kind: 'environment', environmentId: key.slice('environment:'.length) }
  }
  return { kind: 'local' }
}

export function getAutomationTargetFromHostId(
  hostId: string | null | undefined
): AutomationHostTarget {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsed.environmentId }
    : { kind: 'local' }
}

export function getAutomationTargetFromAuthority(
  authority: StableAutomationAuthorityRef
): AutomationHostTarget {
  return authority.kind === 'runtime'
    ? { kind: 'environment', environmentId: authority.environmentId }
    : { kind: 'local' }
}

export async function listAutomationsForTarget(
  target: AutomationHostTarget
): Promise<Automation[]> {
  if (target.kind === 'local') {
    return await window.api.automations.list()
  }
  const result = await callRuntimeRpc<{ automations: Automation[] }>(
    target,
    'automation.list',
    undefined,
    { timeoutMs: 15_000 }
  )
  return result.automations
}

/**
 * One automation's history, never a host's. Usage totals for the list come from
 * the authority's own list projection; fetching every run to compute them made
 * the page's cost scale with retained history rather than with what is on screen.
 */
export async function listAutomationRunsForTarget(
  target: AutomationHostTarget,
  automationId: string
): Promise<AutomationRun[]> {
  if (target.kind === 'local') {
    return await window.api.automations.listRuns({ automationId })
  }
  const result = await callRuntimeRpc<{ runs: AutomationRun[] }>(
    target,
    'automation.runs',
    { automationId },
    { timeoutMs: 15_000 }
  )
  return result.runs
}

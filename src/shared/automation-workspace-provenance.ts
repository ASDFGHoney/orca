import type { Automation, AutomationRun } from './automations-types'
import { getRepoExecutionHostId, parseExecutionHostId } from './execution-host'
import type { Repo } from './repo-types'
import type { AutomationWorkspaceProvenance } from './worktree/types'
import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from './automation-owner-ref'

type AutomationProvenanceRun = Pick<AutomationRun, 'id' | 'title' | 'runContext'>

export function buildAutomationWorkspaceProvenance(
  automation: Automation,
  run: AutomationProvenanceRun,
  repo: Repo,
  createdAt = Date.now(),
  storageAuthority?: AutomationWorkspaceProvenance['storageAuthority']
): AutomationWorkspaceProvenance {
  return {
    kind: 'created-by-automation',
    automationId: automation.id,
    automationNameSnapshot: automation.name,
    automationRunId: run.id,
    automationRunTitleSnapshot: run.title,
    createdAt,
    executionTargetType: automation.executionTargetType,
    executionTargetId: automation.executionTargetId,
    projectId:
      run.runContext?.projectId ?? automation.runContext?.projectId ?? automation.projectId,
    ...(run.runContext?.repoId
      ? { repoId: run.runContext.repoId }
      : automation.runContext?.repoId
        ? { repoId: automation.runContext.repoId }
        : {}),
    hostId: run.runContext?.hostId ?? automation.runContext?.hostId ?? getRepoExecutionHostId(repo),
    ...(storageAuthority ? { storageAuthority } : {})
  }
}

/** Resolves the client-relative authority from portable persisted provenance. */
export function automationWorkspaceStorageAuthority(
  provenance: AutomationWorkspaceProvenance,
  runtimeOwnerEnvironmentId?: string | null
): StableAutomationAuthorityRef | null {
  if (provenance.storageAuthority === 'desktop') {
    return { kind: 'desktop' }
  }
  const runtimeOwner = runtimeOwnerEnvironmentId?.trim()
  if (provenance.storageAuthority === 'runtime') {
    return runtimeOwner ? { kind: 'runtime', environmentId: runtimeOwner } : null
  }
  if (runtimeOwner) {
    return { kind: 'runtime', environmentId: runtimeOwner }
  }
  const host = parseExecutionHostId(provenance.hostId)
  return host?.kind === 'runtime'
    ? { kind: 'runtime', environmentId: host.environmentId }
    : { kind: 'desktop' }
}

/** Resolves the exact storage bucket used by automation navigation. */
export function automationWorkspaceStorageCatalogRef(
  provenance: AutomationWorkspaceProvenance,
  runtimeOwnerEnvironmentId?: string | null
): StableAutomationCatalogRef | null {
  const authority = automationWorkspaceStorageAuthority(provenance, runtimeOwnerEnvironmentId)
  if (!authority) {
    return null
  }
  const host = parseExecutionHostId(provenance.hostId)
  return {
    authority,
    selector: host?.kind === 'ssh' ? { kind: 'ssh', targetId: host.targetId } : { kind: 'self' }
  }
}

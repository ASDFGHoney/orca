import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchRequest,
  AutomationDispatchResult,
  ExternalAutomationManager,
  ExternalAutomationRunsPage,
  AutomationRun,
  AutomationPrecheckResult,
  AutomationUpdateInput
} from '../../shared/automations-types'
import type {
  AutomationListResult,
  AutomationListScopeSelector
} from '../../shared/automation-list-scope'
import type {
  AutomationDestination,
  AutomationOwnerPrecondition
} from '../../shared/automation-owner-precondition'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import type {
  ScopedExternalManagerActionRequest,
  ScopedExternalManagerCreateRequest,
  ScopedExternalManagerListRequest,
  ScopedExternalManagerRunsRequest,
  ScopedExternalManagerUpdateRequest
} from '../../shared/external-automation-scope'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'

/**
 * One host+provider probe result. `manager: null` with `error: null` means the
 * probe succeeded and nothing is configured there — distinct from a failure,
 * which a caller must never render as an empty host.
 */
export type ExternalAutomationManagerResult = {
  manager: ExternalAutomationManager | null
  error: string | null
  updatedAt: number
}

export type AutomationsApi = {
  list: () => Promise<Automation[]>
  /** Host-scoped read of the desktop authority; the caller's captured SSH generation is verified. */
  listScoped: (params: { selector: AutomationListScopeSelector }) => Promise<AutomationListResult>
  listRuns: (args?: {
    automationId?: string
    expectedOwner?: AutomationOwnerPrecondition
  }) => Promise<AutomationRun[]>
  /**
   * Scoped external-manager surface. Every request carries the captured
   * desktop owner it was built from; the provider target and manager ID are
   * derived from that owner in the main process and are never sent alongside it.
   */
  listExternalManagerForOwner: (
    request: ScopedExternalManagerListRequest
  ) => Promise<ExternalAutomationManagerResult>
  listExternalRunsForOwner: (
    request: ScopedExternalManagerRunsRequest
  ) => Promise<ExternalAutomationRunsPage>
  createExternalForOwner: (request: ScopedExternalManagerCreateRequest) => Promise<void>
  updateExternalForOwner: (request: ScopedExternalManagerUpdateRequest) => Promise<void>
  runExternalActionForOwner: (request: ScopedExternalManagerActionRequest) => Promise<void>
  /** Probes outside the retained owners are cancelled; an empty list retains none. */
  retainExternalScopes: (request: { owners: readonly AutomationOwnerRef[] }) => Promise<void>
  create: (
    input: AutomationCreateInput,
    options?: { destination?: AutomationDestination }
  ) => Promise<Automation>
  update: (args: {
    id: string
    updates: AutomationUpdateInput
    expectedOwner?: AutomationOwnerPrecondition
    destination?: AutomationDestination
  }) => Promise<Automation>
  delete: (args: { id: string; expectedOwner?: AutomationOwnerPrecondition }) => Promise<void>
  runNow: (args: {
    id: string
    expectedOwner?: AutomationOwnerPrecondition
  }) => Promise<AutomationRun>
  runPrecheck: (args: {
    automationId: string
    runId: string
  }) => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  snapshotWorkspaceName: (args: { workspaceId: string; displayName: string }) => Promise<number>
  rendererReady: () => Promise<void>
  onDispatchRequested: (callback: (request: AutomationDispatchRequest) => void) => () => void
  onChanged: (callback: (payload: AutomationsChangedPayload) => void) => () => void
}

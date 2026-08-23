/**
 * Owner-qualified automation requests for one authority.
 *
 * Every call carries the incarnation the caller captured: a runtime request is
 * pinned to its `pairingRevision` through the existing environment revision
 * guard, and an SSH-scoped request carries the registration generation the row
 * was fetched under. Responses are validated, never cast — an older host that
 * silently drops the selector answers with its whole authority, and committing
 * that would attribute other hosts' automations to the selected one.
 */

import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import type {
  AutomationListResult,
  AutomationListScopeSelector
} from '../../../../shared/automation-list-scope'
import { validateAutomationListResponse } from '../../../../shared/automation-list-response'
import { partitionLegacyAutomationList } from '../../../../shared/automation-legacy-list-partition'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef
} from '../../../../shared/automation-owner-ref'
/** The one classifier every client shares; re-exported so call sites keep importing it from here. */
export { matchAutomationOwnerConflict } from '../../../../shared/automation-owner-conflict'
import type {
  AutomationDestination,
  AutomationOwnerPrecondition
} from '../../../../shared/automation-owner-precondition'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE
} from '../../../../shared/protocol-version'
import {
  AUTOMATION_AUTHORITY_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
  assertAuthorityCapability,
  assertOwnerFencingSupported,
  AutomationHostScopeUnsupportedError,
  requiresOwnerFencing
} from './automation-authority-capability'
import { runtimeAutomationWorkspaceSelector } from './automation-runtime-workspace-selector'
/** Re-exported so existing call sites keep importing the error from this module. */
export { AutomationHostScopeUnsupportedError } from './automation-authority-capability'

export class AutomationListResponseError extends Error {
  readonly code = 'invalid_response'

  constructor(message: string) {
    super(message)
    this.name = 'AutomationListResponseError'
  }
}

export type ScopedAutomationList = AutomationListResult & {
  /** Rows dropped because their metadata was missing, duplicated, or scoped elsewhere. */
  invalidRows: number
}

function runtimeTarget(authority: AutomationAuthorityRef): RuntimeClientTarget {
  return authority.kind === 'desktop'
    ? { kind: 'local' }
    : { kind: 'environment', environmentId: authority.environmentId }
}

function scopeSelector(owner: AutomationOwnerRef): AutomationListScopeSelector {
  return owner.selector.kind === 'ssh'
    ? {
        kind: 'ssh',
        targetId: owner.selector.targetId,
        expectedTargetGeneration: owner.selector.targetGeneration
      }
    : { kind: 'self' }
}

/** Orphan rows have a known authority and no executable owner, so delete/pause fence on that instead. */
export const ORPHAN_OWNER_PRECONDITION: AutomationOwnerPrecondition = {
  selector: { kind: 'orphan' }
}

export function ownerPrecondition(owner: AutomationOwnerRef): AutomationOwnerPrecondition {
  return {
    selector:
      owner.selector.kind === 'ssh'
        ? {
            kind: 'ssh',
            targetId: owner.selector.targetId,
            targetGeneration: owner.selector.targetGeneration
          }
        : { kind: 'self' }
  }
}

async function callAuthority<TResult>(
  authority: AutomationAuthorityRef,
  method: string,
  params: unknown
): Promise<TResult> {
  return await callRuntimeRpc<TResult>(runtimeTarget(authority), method, params, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    // Why: a same-id re-pair must invalidate this request instead of retargeting it.
    ...(authority.kind === 'runtime'
      ? { expectedEnvironmentPairingRevision: authority.pairingRevision }
      : {})
  })
}

function validated(raw: unknown, selector: AutomationListScopeSelector): ScopedAutomationList {
  const validation = validateAutomationListResponse(raw, selector)
  if (!validation.ok) {
    throw validation.error.code === 'unsupported_host_scope'
      ? new AutomationHostScopeUnsupportedError(validation.error.message)
      : new AutomationListResponseError(validation.error.message)
  }
  return { ...validation.result, invalidRows: validation.invalidRows }
}

export async function listScopedAutomations(
  authority: AutomationAuthorityRef,
  selector: AutomationListScopeSelector
): Promise<ScopedAutomationList> {
  if (authority.kind === 'desktop') {
    return validated(await window.api.automations.listScoped({ selector }), selector)
  }
  await assertAuthorityCapability(
    authority,
    AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
    AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE
  )
  return validated(await callAuthority(authority, 'automation.list', { selector }), selector)
}

/**
 * The one unscoped request an old runtime gets per refresh cycle. Its result is
 * partitioned client-side into every requested entry; it carries no generations
 * and no usage projection, so its SSH rows stay view-only. The partition may
 * still assign owners where none are needed on the wire — Self.
 */
export async function listLegacyAutomations(
  authority: AutomationAuthorityRef
): Promise<Automation[]> {
  if (authority.kind === 'desktop') {
    // Desktop storage ships the scoped contract in-process, so it never degrades.
    throw new AutomationListResponseError('The desktop authority always supports scoped lists.')
  }
  const raw = await callAuthority<unknown>(authority, 'automation.list', null)
  const automations = (raw as { automations?: unknown } | null)?.automations
  if (!Array.isArray(automations)) {
    throw new AutomationListResponseError('The host returned an unreadable automation list.')
  }
  return automations as Automation[]
}

/**
 * Self read on a server without host-scoped lists: the unscoped list is asked
 * for and partitioned client-side, never a scoped request the server would
 * answer with its whole store. Project evidence lives on the answering
 * authority, so none is available here and every plausible local record reads
 * as Self — the same id-keyed trust the legacy server itself applies, and the
 * caller looks rows up by id.
 */
async function listLegacySelfAutomations(
  authority: AutomationAuthorityRef
): Promise<ScopedAutomationList> {
  const automations = await listLegacyAutomations(authority)
  const partition = partitionLegacyAutomationList(automations, {
    repoConnectionId: () => null,
    projectsAuthoritative: false
  })
  const selfRows = partition.rows.filter((row) => row.selector.kind === 'self')
  return {
    automations: selfRows.map((row) => row.automation),
    items: selfRows.map((row) => ({
      automationId: row.automation.id,
      selector: { kind: 'self' }
    })),
    invalidRows: 0
  }
}

/** Convenience wrapper for a row's own host; orphan scopes are requested with the selector form. */
export async function listAutomationsForOwner(
  owner: AutomationOwnerRef
): Promise<ScopedAutomationList> {
  try {
    return await listScopedAutomations(owner.authority, scopeSelector(owner))
  } catch (error) {
    // Only Self may degrade: its records live on the authority the request is
    // already pinned to. An SSH owner keeps failing closed on an old server.
    if (
      owner.authority.kind === 'runtime' &&
      owner.selector.kind === 'self' &&
      error instanceof AutomationHostScopeUnsupportedError
    ) {
      return await listLegacySelfAutomations(owner.authority)
    }
    throw error
  }
}

/**
 * The only place that chooses IPC or RPC for a fenced run history read.
 *
 * Deliberately unprobed, matching the mutation arms' *absence* of a probe here:
 * history is read-only, and an older host that ignores the precondition answers
 * with the rows it has rather than acting on a fence it never honoured.
 */
async function listRunsFenced(
  authority: AutomationAuthorityRef,
  automationId: string,
  expectedOwner: AutomationOwnerPrecondition
): Promise<AutomationRun[]> {
  if (authority.kind === 'desktop') {
    return await window.api.automations.listRuns({ automationId, expectedOwner })
  }
  const result = await callAuthority<{ runs: AutomationRun[] }>(authority, 'automation.runs', {
    automationId,
    expectedOwner
  })
  return result.runs
}

export async function listAutomationRunsForOwner(
  owner: AutomationOwnerRef,
  automationId: string
): Promise<AutomationRun[]> {
  return await listRunsFenced(owner.authority, automationId, ownerPrecondition(owner))
}

/**
 * The only place that chooses IPC or RPC for a fenced mutation. Owned and orphan
 * rows differ in the precondition they fence with and in nothing else, so they
 * share the transport, the capability probe, and any check either later gains.
 */
async function updateFenced(
  authority: AutomationAuthorityRef,
  id: string,
  updates: AutomationUpdateInput,
  expectedOwner: AutomationOwnerPrecondition,
  destination?: AutomationDestination
): Promise<Automation> {
  if (requiresOwnerFencing(expectedOwner, destination)) {
    await assertOwnerFencingSupported(authority)
  }
  if (authority.kind === 'desktop') {
    return await window.api.automations.update({ id, updates, expectedOwner, destination })
  }
  const { projectId, workspaceId, ...runtimeUpdates } = updates
  const result = await callAuthority<{ automation: Automation }>(authority, 'automation.update', {
    id,
    updates: {
      ...runtimeUpdates,
      ...('projectId' in updates ? { repo: projectId } : {}),
      ...('workspaceId' in updates
        ? { workspace: runtimeAutomationWorkspaceSelector(workspaceId) }
        : {})
    },
    expectedOwner,
    destination
  })
  return result.automation
}

async function deleteFenced(
  authority: AutomationAuthorityRef,
  id: string,
  expectedOwner: AutomationOwnerPrecondition
): Promise<void> {
  if (requiresOwnerFencing(expectedOwner)) {
    await assertOwnerFencingSupported(authority)
  }
  if (authority.kind === 'desktop') {
    await window.api.automations.delete({ id, expectedOwner })
    return
  }
  await callAuthority(authority, 'automation.delete', { id, expectedOwner })
}

export async function updateAutomationForOwner(
  owner: AutomationOwnerRef,
  id: string,
  updates: AutomationUpdateInput,
  destination?: AutomationDestination
): Promise<Automation> {
  return await updateFenced(owner.authority, id, updates, ownerPrecondition(owner), destination)
}

export async function deleteAutomationForOwner(
  owner: AutomationOwnerRef,
  id: string
): Promise<void> {
  await deleteFenced(owner.authority, id, ownerPrecondition(owner))
}

/**
 * Orphan rows have no owner to key by, so the orphan precondition is the fence.
 * The authority is still known and still probed: an orphan on an out-of-date
 * host is refused for the same reason an owned row there is.
 *
 * No destination is accepted — moving a row needs a host it can move to.
 */
export async function updateOrphanAutomation(
  authority: AutomationAuthorityRef,
  id: string,
  updates: AutomationUpdateInput
): Promise<Automation> {
  return await updateFenced(authority, id, updates, ORPHAN_OWNER_PRECONDITION)
}

export async function deleteOrphanAutomation(
  authority: AutomationAuthorityRef,
  id: string
): Promise<void> {
  await deleteFenced(authority, id, ORPHAN_OWNER_PRECONDITION)
}

/**
 * An orphan keeps its history: reading past runs needs no host to run on, which
 * is why `ORPHAN_ACTIONS` allows it where execution is blocked.
 */
export async function listOrphanAutomationRuns(
  authority: AutomationAuthorityRef,
  automationId: string
): Promise<AutomationRun[]> {
  return await listRunsFenced(authority, automationId, ORPHAN_OWNER_PRECONDITION)
}

export async function runAutomationNowForOwner(
  owner: AutomationOwnerRef,
  id: string
): Promise<AutomationRun> {
  const expectedOwner = ownerPrecondition(owner)
  if (requiresOwnerFencing(expectedOwner)) {
    await assertOwnerFencingSupported(owner.authority)
  }
  if (owner.authority.kind === 'desktop') {
    return await window.api.automations.runNow({ id, expectedOwner })
  }
  const result = await callAuthority<{ run: AutomationRun }>(owner.authority, 'automation.runNow', {
    id,
    expectedOwner
  })
  return result.run
}

export async function createAutomationForDestination(
  authority: AutomationAuthorityRef,
  input: AutomationCreateInput,
  destination: AutomationDestination
): Promise<Automation> {
  // A Self destination degrades safely on an old server: with the field ignored,
  // the record still lands on that authority's local store — which is Self.
  if (destination.selector.kind !== 'self') {
    await assertOwnerFencingSupported(authority)
  }
  if (authority.kind === 'desktop') {
    return await window.api.automations.create(input, { destination })
  }
  const { projectId, workspaceId, ...rest } = input
  const result = await callAuthority<{ automation: Automation }>(authority, 'automation.create', {
    ...rest,
    repo: projectId,
    workspace:
      input.workspaceMode === 'existing'
        ? runtimeAutomationWorkspaceSelector(workspaceId)
        : undefined,
    destination
  })
  return result.automation
}

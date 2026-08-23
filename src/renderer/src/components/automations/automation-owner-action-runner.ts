/**
 * Runs one action against a row's captured owner and reports the result as
 * data.
 *
 * Owner conflicts are ordinary outcomes here, not exceptions: the host changed,
 * the target is gone, the server is too old to fence, or the chosen destination
 * no longer resolves. Each one has something the user can do next, so each is
 * returned with the recovery action the host-status vocabulary already defines
 * rather than thrown into a generic failure toast.
 *
 * Nothing in this module reads ambient state. The availability it is handed was
 * computed from the row the user acted on, and every request is fenced with it.
 */

import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import {
  automationOwnerConflictMessage,
  stripAutomationOwnerConflictCode,
  type AutomationOwnerConflictCode
} from '../../../../shared/automation-owner-conflict'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef
} from '../../../../shared/automation-owner-ref'
import type { AutomationDestination } from '../../../../shared/automation-owner-precondition'
import { translate } from '@/i18n/i18n'
import type {
  AutomationActionAvailability,
  AutomationActionBlock
} from './automation-captured-owner'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import {
  AutomationHostScopeUnsupportedError,
  createAutomationForDestination,
  deleteAutomationForOwner,
  deleteOrphanAutomation,
  listAutomationRunsForOwner,
  listAutomationsForOwner,
  listOrphanAutomationRuns,
  matchAutomationOwnerConflict,
  runAutomationNowForOwner,
  updateAutomationForOwner,
  updateOrphanAutomation
} from './automation-scoped-list-client'

export type AutomationOwnerConflict = {
  code: AutomationOwnerConflictCode | 'unsupported_host_scope'
  message: string
  /** Null when no offered action would help — re-adding a removed host is manual. */
  recovery: AutomationHostRecoveryAction | null
}

export type AutomationActionOutcome<TValue> =
  | { status: 'ok'; value: TValue }
  | { status: 'blocked'; block: AutomationActionBlock }
  | { status: 'conflict'; conflict: AutomationOwnerConflict }
  | { status: 'failed'; message: string }

const CONFLICT_RECOVERY: Record<AutomationOwnerConflictCode, AutomationHostRecoveryAction | null> =
  {
    automation_owner_changed: 'retry',
    // The host was deregistered; nothing the page can retry or reconnect brings it back.
    automation_target_removed: null,
    automation_owner_fencing_required: 'update-server',
    automation_destination_invalid: 'retry'
  }

function conflictOutcome(code: AutomationOwnerConflictCode): AutomationActionOutcome<never> {
  return {
    status: 'conflict',
    conflict: {
      code,
      message: automationOwnerConflictMessage(code),
      recovery: CONFLICT_RECOVERY[code]
    }
  }
}

function classify(error: unknown): AutomationActionOutcome<never> {
  const conflict = matchAutomationOwnerConflict(error)
  if (conflict) {
    return conflictOutcome(conflict)
  }
  if (error instanceof AutomationHostScopeUnsupportedError) {
    return {
      status: 'conflict',
      conflict: {
        code: 'unsupported_host_scope',
        message: stripAutomationOwnerConflictCode(error.message),
        recovery: 'update-server'
      }
    }
  }
  if (hasRuntimeRpcErrorCode(error, 'selector_not_found')) {
    return {
      status: 'failed',
      message: translate(
        'auto.components.automations.ownerAction.workspaceNotFound',
        "We couldn't find that workspace on this host. Choose a workspace that exists here and try again."
      )
    }
  }
  return {
    status: 'failed',
    message:
      error instanceof Error
        ? stripAutomationOwnerConflictCode(error.message)
        : translate(
            'auto.components.automations.ownerAction.failed',
            'That automation action did not complete.'
          )
  }
}

/**
 * The captured owner decides whether the request is made at all, so a blocked
 * row never reaches the transport and an uncaptured one is handed back to the
 * caller's legacy path instead of being run against a guessed owner.
 */
async function attempt<TValue>(
  availability: AutomationActionAvailability,
  owned: (owner: AutomationOwnerRef) => Promise<TValue>,
  orphanFenced?: () => Promise<TValue>
): Promise<AutomationActionOutcome<TValue>> {
  if (availability.kind === 'blocked') {
    return { status: 'blocked', block: availability.block }
  }
  try {
    if (availability.kind === 'owned') {
      return { status: 'ok', value: await owned(availability.owner) }
    }
    if (!orphanFenced) {
      return { status: 'blocked', block: orphanUnsupported() }
    }
    return { status: 'ok', value: await orphanFenced() }
  } catch (error) {
    return classify(error)
  }
}

function orphanUnsupported(): AutomationActionBlock {
  return {
    reason: 'orphan',
    message: translate(
      'auto.components.automations.capturedOwner.orphan',
      'This automation has no host to run on. Delete it, or re-add the host it belongs to.'
    ),
    recovery: null
  }
}

export type AutomationActionResult<TValue> = AutomationActionOutcome<TValue>

export async function updateOwnedAutomation(
  availability: AutomationActionAvailability,
  id: string,
  updates: AutomationUpdateInput,
  destination?: AutomationDestination
): Promise<AutomationActionResult<Automation>> {
  return await attempt(
    availability,
    (owner) => updateAutomationForOwner(owner, id, updates, destination),
    () =>
      availability.kind === 'orphan-fenced'
        ? updateOrphanAutomation(availability.authority, id, updates)
        : Promise.reject(new Error('automation_owner_uncaptured'))
  )
}

export async function deleteOwnedAutomation(
  availability: AutomationActionAvailability,
  id: string
): Promise<AutomationActionResult<void>> {
  return await attempt(
    availability,
    (owner) => deleteAutomationForOwner(owner, id),
    () =>
      availability.kind === 'orphan-fenced'
        ? deleteOrphanAutomation(availability.authority, id)
        : Promise.reject(new Error('automation_owner_uncaptured'))
  )
}

export async function runOwnedAutomationNow(
  availability: AutomationActionAvailability,
  id: string
): Promise<AutomationActionResult<AutomationRun>> {
  return await attempt(availability, (owner) => runAutomationNowForOwner(owner, id))
}

/**
 * Edit hydration re-reads the record inside its captured scope, so a row that
 * moved hosts since the list is reported as gone rather than silently replaced
 * by another authority's record with the same ID.
 */
export async function showOwnedAutomation(
  availability: AutomationActionAvailability,
  id: string
): Promise<AutomationActionResult<Automation | null>> {
  return await attempt(availability, async (owner) => {
    const result = await listAutomationsForOwner(owner)
    return result.automations.find((automation) => automation.id === id) ?? null
  })
}

export async function listOwnedAutomationRuns(
  availability: AutomationActionAvailability,
  automationId: string
): Promise<AutomationActionResult<AutomationRun[]>> {
  return await attempt(
    availability,
    (owner) => listAutomationRunsForOwner(owner, automationId),
    () =>
      availability.kind === 'orphan-fenced'
        ? listOrphanAutomationRuns(availability.authority, automationId)
        : Promise.reject(new Error('automation_owner_uncaptured'))
  )
}

/** Create is destination-keyed rather than owner-keyed: the row does not exist yet. */
export async function createAutomationAtDestination(
  authority: AutomationAuthorityRef,
  input: AutomationCreateInput,
  destination: AutomationDestination
): Promise<AutomationActionOutcome<Automation>> {
  try {
    return {
      status: 'ok',
      value: await createAutomationForDestination(authority, input, destination)
    }
  } catch (error) {
    return classify(error)
  }
}

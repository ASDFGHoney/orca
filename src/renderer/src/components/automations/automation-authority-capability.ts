/**
 * Capability gates for owner-qualified automation requests.
 *
 * A request fails closed on a *known* missing capability and on nothing else:
 * an unreachable authority must classify as unavailable and retry, never as an
 * old server the user is told to upgrade.
 */

import { getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type {
  AutomationDestination,
  AutomationOwnerPrecondition
} from '../../../../shared/automation-owner-precondition'
import {
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import { automationHostDiagnostics } from './automation-host-diagnostics'

export const AUTOMATION_AUTHORITY_REQUEST_TIMEOUT_MS = 15_000

export class AutomationHostScopeUnsupportedError extends Error {
  readonly code = 'unsupported_host_scope'

  constructor(message: string) {
    super(message)
    this.name = 'AutomationHostScopeUnsupportedError'
  }
}

/**
 * The probe is counted here because it is counted nowhere else: it deliberately
 * re-fetches on every call and rides outside the scheduler's four-slot pool, so
 * an instrument that saw only pooled work would report half the relay traffic a
 * 50-host refresh actually costs.
 */
export async function assertAuthorityCapability(
  authority: AutomationAuthorityRef,
  capability: RuntimeCapability,
  message: string
): Promise<void> {
  if (authority.kind !== 'runtime') {
    return
  }
  automationHostDiagnostics.recordCapabilityProbe({
    authorityKey: automationAuthorityCatalogKey(authority)
  })
  const status = await getRuntimeEnvironmentStatus(
    authority.environmentId,
    AUTOMATION_AUTHORITY_REQUEST_TIMEOUT_MS
  )
  if (!status.capabilities?.includes(capability)) {
    throw new AutomationHostScopeUnsupportedError(message)
  }
}

export async function assertOwnerFencingSupported(
  authority: AutomationAuthorityRef
): Promise<void> {
  await assertAuthorityCapability(
    authority,
    AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
    AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE
  )
}

/**
 * Whether a mutation must fail closed on a server without owner fencing.
 *
 * Self is exempt: a Self record lives on the answering authority, the request
 * is already pinned to the pairing revision the row was captured under, and an
 * id-based mutation is exactly what a pre-fencing server performs today. SSH
 * and orphan selectors still fail closed — a same-id remove/re-add could
 * otherwise run or edit on a machine the user never saw. A destination
 * re-attaches the record, so it always needs the fenced contract: an old server
 * would ignore the field and silently leave the record where it was.
 */
export function requiresOwnerFencing(
  expectedOwner: AutomationOwnerPrecondition,
  destination?: AutomationDestination
): boolean {
  return expectedOwner.selector.kind !== 'self' || destination !== undefined
}

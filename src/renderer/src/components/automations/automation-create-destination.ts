/**
 * Where a new automation is created, stated explicitly.
 *
 * Creation never infers a host. A concrete host filter constrains the
 * destination; under All hosts the active workspace's host may pre-fill it, but
 * only when that host resolves to a catalog entry with a real executable owner.
 * Anything less — an orphan bucket, an unhydrated or ghost host, no selection
 * at all — asks the user instead of picking for them, because a silent default
 * here creates a scheduled job on a machine nobody chose.
 *
 * The destination is re-resolved immediately before submit so a host that
 * changed incarnation while the form was open fails closed with the form
 * intact, rather than landing the record on a re-registered target.
 */

import type {
  AutomationAuthorityRef,
  AutomationOwnerRef,
  StableAutomationAuthorityRef
} from '../../../../shared/automation-owner-ref'
import type { AutomationDestination } from '../../../../shared/automation-owner-precondition'
import { hostStableKey, isSameAutomationOwner } from '../../../../shared/automation-owner-key'
import {
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  AutomationCatalogHydrationEvidence,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import {
  automationRepoOwningAuthority,
  repoConnectionIdIn,
  type AutomationAuthorityRepoTables
} from './automation-authority-identity'

export type AutomationCreateDestinationChoiceReason =
  /** No host is selected and nothing may be assumed. */
  | 'unselected'
  /** The selection is the authority's orphan bucket, which cannot own new records. */
  | 'orphan'
  /** The host is known but has no executable owner yet: ghost, unhydrated, or legacy. */
  | 'unavailable'

export type AutomationCreateDestination = {
  authority: AutomationAuthorityRef
  destination: AutomationDestination
  /** The entry the user will see named on the form before submit. */
  entry: AutomationHostCatalogEntry
}

export type AutomationCreateDestinationResolution =
  | ({ status: 'ready' } & AutomationCreateDestination)
  | { status: 'choice-required'; reason: AutomationCreateDestinationChoiceReason }

export function resolveAutomationCreateDestination(
  entry: AutomationHostCatalogEntry | null | undefined
): AutomationCreateDestinationResolution {
  if (!entry) {
    return { status: 'choice-required', reason: 'unselected' }
  }
  if (entry.kind === 'orphan') {
    return { status: 'choice-required', reason: 'orphan' }
  }
  if (!entry.owner) {
    return { status: 'choice-required', reason: 'unavailable' }
  }
  return {
    status: 'ready',
    authority: entry.owner.authority,
    destination: { selector: entry.owner.selector },
    entry
  }
}

/**
 * Under All hosts, a pre-fill is a convenience, never a fallback: an
 * unresolvable active workspace leaves the choice to the user.
 */
export function preselectAutomationCreateHost(
  entries: readonly AutomationHostCatalogEntry[],
  selectedStableKey: string | null,
  activeWorkspaceStableKey: string | null
): AutomationHostCatalogEntry | null {
  const key = selectedStableKey ?? activeWorkspaceStableKey
  if (!key) {
    return null
  }
  return entries.find((entry) => entry.stableKey === key) ?? null
}

/**
 * Re-resolves the captured destination against the live catalog. A changed
 * incarnation is reported rather than followed, so the caller can keep the form
 * and say which host moved.
 */
export function revalidateAutomationCreateDestination(
  captured: AutomationCreateDestination,
  entries: readonly AutomationHostCatalogEntry[]
): AutomationCreateDestinationResolution | { status: 'stale'; entry: AutomationHostCatalogEntry } {
  const current = entries.find((entry) => entry.stableKey === captured.entry.stableKey)
  const resolved = resolveAutomationCreateDestination(current)
  if (resolved.status !== 'ready') {
    return resolved
  }
  return isSameAutomationOwner(destinationOwner(resolved), destinationOwner(captured))
    ? resolved
    : { status: 'stale', entry: resolved.entry }
}

/**
 * One eligible host is not a guess: with nothing else the user could choose, the
 * destination is still stated. Gated on positive hydration evidence, because a
 * catalog that has not settled can look single-host while a second one loads.
 */
export function soleAutomationCreateHost(
  entries: readonly AutomationHostCatalogEntry[],
  hydration: AutomationCatalogHydrationEvidence
): AutomationHostCatalogEntry | null {
  if (!hydration.runtimeCatalogSettled || !hydration.desktopSshHydrated) {
    return null
  }
  const eligible = entries.filter((entry) => entry.kind !== 'orphan' && entry.owner)
  return eligible.length === 1 ? (eligible[0] ?? null) : null
}

/** The catalog host a workspace's execution host names, for the All-hosts pre-fill. */
export function automationCreateHostStableKey(
  hostId: string | null | undefined,
  runtimeOwnerEnvironmentId?: string | null
): string | null {
  const host = parseExecutionHostId(hostId)
  const runtimeOwner = runtimeOwnerEnvironmentId?.trim()
  if (!host && !runtimeOwner) {
    return null
  }
  if (runtimeOwner || host?.kind === 'runtime') {
    const environmentId = runtimeOwner || (host?.kind === 'runtime' ? host.environmentId : '')
    return hostStableKey({
      authority: { kind: 'runtime', environmentId },
      selector: host?.kind === 'ssh' ? { kind: 'ssh', targetId: host.targetId } : { kind: 'self' }
    })
  }
  // A desktop SSH workspace is still desktop-stored; only the selector differs.
  return hostStableKey({
    authority: { kind: 'desktop' },
    selector: host?.kind === 'ssh' ? { kind: 'ssh', targetId: host.targetId } : { kind: 'self' }
  })
}

/**
 * Whether the project can live on the destination at all, checked against the
 * destination authority's own repo table.
 *
 * Only the desktop table is a verdict: a runtime's repos reach this client as a
 * mirror that can lag, so a miss there leaves the project unverified for the
 * authority to reject, while a miss in the desktop's own table is proof.
 */
export function automationCreateProjectMismatch(
  tables: AutomationAuthorityRepoTables,
  destination: AutomationCreateDestination,
  projectId: string
): boolean {
  const authority = destination.authority
  const table = tables.get(automationAuthorityCatalogKey(authority))
  const connectionId = table ? repoConnectionIdIn(table)(projectId) : undefined
  if (connectionId === undefined) {
    return authority.kind === 'desktop'
  }
  const selector = destination.destination.selector
  return selector.kind === 'ssh' ? connectionId !== selector.targetId : connectionId !== null
}

function authoritiesMatch(
  left: StableAutomationAuthorityRef,
  right: StableAutomationAuthorityRef
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'desktop' ||
      (right.kind === 'runtime' && left.environmentId === right.environmentId))
  )
}

function connectionMatchesDestination(
  connectionId: string | null | undefined,
  destination: AutomationCreateDestination
): boolean {
  const normalized = connectionId?.trim() || null
  const selector = destination.destination.selector
  return selector.kind === 'ssh' ? normalized === selector.targetId : normalized === null
}

export function automationCreateRepoMatchesDestination(
  repo: Repo,
  destination: AutomationCreateDestination
): boolean {
  return (
    authoritiesMatch(automationRepoOwningAuthority(repo), destination.authority) &&
    connectionMatchesDestination(repo.connectionId, destination)
  )
}

/**
 * The projects a destination can hold, filtered by the rule submit already
 * enforces, so the form cannot offer a pairing its own check will refuse.
 */
export function automationCreateEligibleProjects(
  destination: AutomationCreateDestination,
  projects: readonly Repo[],
  projectHostSetups: readonly ProjectHostSetup[]
): Repo[] {
  return projects.filter(
    (project) =>
      automationCreateRepoMatchesDestination(project, destination) ||
      projectHostSetups.some(
        (setup) =>
          setup.repoId === project.id &&
          setup.setupState === 'ready' &&
          automationCreateSetupMatchesDestination(setup, destination)
      )
  )
}

function destinationExecutionHostId(destination: AutomationCreateDestination): ExecutionHostId {
  const selector = destination.destination.selector
  if (selector.kind === 'ssh') {
    return toSshExecutionHostId(selector.targetId)
  }
  return destination.authority.kind === 'runtime'
    ? toRuntimeExecutionHostId(destination.authority.environmentId)
    : LOCAL_EXECUTION_HOST_ID
}

/** The host whose workspace catalog the client can authoritatively refresh. */
export function automationCreateWorkspaceRefreshHostId(
  destination: AutomationCreateDestination
): ExecutionHostId {
  return destination.authority.kind === 'runtime'
    ? toRuntimeExecutionHostId(destination.authority.environmentId)
    : destinationExecutionHostId(destination)
}

function runtimeOwnerMatches(
  runtimeOwnerEnvironmentId: string | null | undefined,
  hostId: ExecutionHostId | null,
  destination: AutomationCreateDestination
): boolean {
  if (destination.authority.kind === 'desktop') {
    return !runtimeOwnerEnvironmentId && parseExecutionHostId(hostId)?.kind !== 'runtime'
  }
  if (runtimeOwnerEnvironmentId) {
    return runtimeOwnerEnvironmentId === destination.authority.environmentId
  }
  const host = parseExecutionHostId(hostId)
  return host?.kind === 'runtime' && host.environmentId === destination.authority.environmentId
}

export function automationCreateWorktreeMatchesDestination(
  worktree: Worktree,
  repo: Repo,
  destination: AutomationCreateDestination,
  projectHostSetups: readonly ProjectHostSetup[] = []
): boolean {
  if (worktree.repoId !== repo.id) {
    return false
  }
  const setup = worktree.projectHostSetupId
    ? projectHostSetups.find(
        (candidate) =>
          candidate.id === worktree.projectHostSetupId &&
          automationCreateSetupMatchesDestination(candidate, destination)
      )
    : undefined
  const hostId =
    normalizeExecutionHostId(worktree.hostId) ??
    normalizeExecutionHostId(setup?.executionHostId) ??
    normalizeExecutionHostId(setup?.hostId) ??
    getWorktreeExecutionHostId(worktree, repo)
  return (
    runtimeOwnerMatches(
      worktree.runtimeOwnerEnvironmentId ?? setup?.runtimeOwnerEnvironmentId,
      hostId,
      destination
    ) && hostId === destinationExecutionHostId(destination)
  )
}

export function automationCreateEligibleWorktrees(
  destination: AutomationCreateDestination,
  repo: Repo | null | undefined,
  worktrees: readonly Worktree[],
  projectHostSetups: readonly ProjectHostSetup[] = []
): Worktree[] {
  return repo
    ? worktrees.filter((worktree) =>
        automationCreateWorktreeMatchesDestination(worktree, repo, destination, projectHostSetups)
      )
    : []
}

export function automationCreateSetupMatchesDestination(
  setup: ProjectHostSetup,
  destination: AutomationCreateDestination
): boolean {
  const transportHostId = normalizeExecutionHostId(setup.hostId)
  const executionHostId = normalizeExecutionHostId(setup.executionHostId) ?? transportHostId
  return (
    runtimeOwnerMatches(setup.runtimeOwnerEnvironmentId, transportHostId, destination) &&
    executionHostId === destinationExecutionHostId(destination)
  )
}

function destinationOwner(value: AutomationCreateDestination): AutomationOwnerRef {
  return { authority: value.authority, selector: value.destination.selector }
}

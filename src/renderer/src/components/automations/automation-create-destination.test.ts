import { describe, expect, it } from 'vitest'
import type {
  AutomationCatalogHydrationEvidence,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import {
  automationCreateEligibleProjects,
  automationCreateEligibleWorktrees,
  automationCreateHostStableKey,
  automationCreateProjectMismatch,
  automationCreateSetupMatchesDestination,
  automationCreateWorkspaceRefreshHostId,
  preselectAutomationCreateHost,
  resolveAutomationCreateDestination,
  revalidateAutomationCreateDestination,
  soleAutomationCreateHost
} from './automation-create-destination'
import { groupReposByAutomationAuthority } from './automation-authority-identity'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ProjectHostSetup } from '../../../../shared/project-types'

function entry(overrides: Partial<AutomationHostCatalogEntry> = {}): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    stableKey: 'desktop:self',
    label: 'This computer',
    authorityLabel: 'Desktop',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped',
    ...overrides
  }
}

function sshEntry(targetGeneration: number): AutomationHostCatalogEntry {
  return entry({
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 'box' } },
    owner: {
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: 'box', targetGeneration }
    },
    stableKey: 'desktop:ssh:box',
    kind: 'ssh'
  })
}

describe('create destination resolution', () => {
  it('states the destination from the chosen host', () => {
    expect(resolveAutomationCreateDestination(entry())).toMatchObject({
      status: 'ready',
      authority: { kind: 'desktop' },
      destination: { selector: { kind: 'self' } }
    })
  })

  it('asks for a choice instead of defaulting one', () => {
    expect(resolveAutomationCreateDestination(null)).toEqual({
      status: 'choice-required',
      reason: 'unselected'
    })
    expect(resolveAutomationCreateDestination(entry({ kind: 'orphan' }))).toEqual({
      status: 'choice-required',
      reason: 'orphan'
    })
    expect(resolveAutomationCreateDestination(entry({ owner: null }))).toEqual({
      status: 'choice-required',
      reason: 'unavailable'
    })
  })

  it('prefers the explicit selection and only then the active workspace', () => {
    const entries = [entry(), sshEntry(3)]
    expect(
      preselectAutomationCreateHost(entries, 'desktop:ssh:box', 'desktop:self')?.stableKey
    ).toBe('desktop:ssh:box')
    expect(preselectAutomationCreateHost(entries, null, 'desktop:self')?.stableKey).toBe(
      'desktop:self'
    )
    // An unresolvable workspace host leaves the choice open rather than picking one.
    expect(preselectAutomationCreateHost(entries, null, 'desktop:ssh:gone')).toBeNull()
    expect(preselectAutomationCreateHost(entries, null, null)).toBeNull()
  })
})

describe('create destination revalidation', () => {
  const captured = {
    authority: { kind: 'desktop' } as const,
    destination: { selector: { kind: 'ssh' as const, targetId: 'box', targetGeneration: 3 } },
    entry: sshEntry(3)
  }

  it('accepts a destination whose incarnation is unchanged', () => {
    expect(revalidateAutomationCreateDestination(captured, [sshEntry(3)]).status).toBe('ready')
  })

  it('reports a re-registered target as stale rather than following it', () => {
    expect(revalidateAutomationCreateDestination(captured, [sshEntry(4)])).toMatchObject({
      status: 'stale'
    })
  })

  it('reports a host that left the catalog as needing a choice', () => {
    expect(revalidateAutomationCreateDestination(captured, [])).toEqual({
      status: 'choice-required',
      reason: 'unselected'
    })
  })
})

describe('sole create host', () => {
  const hydrated: AutomationCatalogHydrationEvidence = {
    runtimeCatalogSettled: true,
    desktopSshHydrated: true,
    runtimeSshHydratedByEnvironmentId: new Map(),
    savedRuntimeEnvironmentIds: new Set(),
    orphanSettledAuthorityKeys: new Set(),
    unavailableAuthorityKeys: new Set()
  }

  it('states the only eligible host and never one of several', () => {
    expect(soleAutomationCreateHost([entry()], hydrated)?.stableKey).toBe('desktop:self')
    expect(soleAutomationCreateHost([entry(), sshEntry(3)], hydrated)).toBeNull()
    // An orphan bucket and an unowned host are not candidates at all.
    expect(
      soleAutomationCreateHost([entry(), entry({ stableKey: 'orphan', kind: 'orphan' })], hydrated)
        ?.stableKey
    ).toBe('desktop:self')
  })

  it('states nothing until the catalog has settled', () => {
    expect(
      soleAutomationCreateHost([entry()], { ...hydrated, runtimeCatalogSettled: false })
    ).toBeNull()
    expect(
      soleAutomationCreateHost([entry()], { ...hydrated, desktopSshHydrated: false })
    ).toBeNull()
  })
})

describe('create host stable key', () => {
  it('maps a workspace host to the catalog host that would store its automations', () => {
    expect(automationCreateHostStableKey('local')).toBe('host:desktop:self')
    // A desktop SSH workspace is still desktop-stored; only the selector differs.
    expect(automationCreateHostStableKey('ssh:box')).toBe('host:desktop:ssh:box')
    expect(automationCreateHostStableKey('runtime:gpu')).toBe('host:runtime:gpu:self')
    expect(automationCreateHostStableKey('ssh:box', 'gpu')).toBe('host:runtime:gpu:ssh:box')
    expect(automationCreateHostStableKey(null)).toBeNull()
  })
})

describe('create project mismatch', () => {
  function repo(overrides: Partial<Repo>): Repo {
    return {
      id: 'repo-1',
      displayName: 'orca',
      path: '/repos/orca',
      badgeColor: '#000000',
      addedAt: 1,
      worktreeBaseRef: 'main',
      ...overrides
    } as Repo
  }
  const desktopSelf = {
    authority: { kind: 'desktop' } as const,
    destination: { selector: { kind: 'self' as const } },
    entry: entry()
  }

  it('refuses a project the destination authority does not hold as local', () => {
    const tables = groupReposByAutomationAuthority([
      repo({ id: 'runtime-repo', executionHostId: 'runtime:gpu' }),
      repo({ id: 'ssh-repo', connectionId: 'box' })
    ])
    // No connection ID is not evidence of local: this repo is the runtime's.
    expect(automationCreateProjectMismatch(tables, desktopSelf, 'runtime-repo')).toBe(true)
    expect(automationCreateProjectMismatch(tables, desktopSelf, 'ssh-repo')).toBe(true)
    expect(automationCreateProjectMismatch(tables, desktopSelf, 'repo-1')).toBe(true)
    expect(
      automationCreateProjectMismatch(
        tables,
        {
          ...desktopSelf,
          destination: { selector: { kind: 'ssh', targetId: 'box', targetGeneration: 3 } }
        },
        'ssh-repo'
      )
    ).toBe(false)
  })

  it('leaves a runtime mirror miss unverified rather than calling it a mismatch', () => {
    const tables = groupReposByAutomationAuthority([repo({ id: 'repo-1' })])
    const runtimeSelf = {
      authority: { kind: 'runtime' as const, environmentId: 'gpu', pairingRevision: 4 },
      destination: { selector: { kind: 'self' as const } },
      entry: entry()
    }
    expect(automationCreateProjectMismatch(tables, runtimeSelf, 'repo-1')).toBe(false)
    // The desktop's own table is a verdict, so its miss does refuse.
    expect(automationCreateProjectMismatch(tables, desktopSelf, 'missing')).toBe(true)
  })

  it('offers only concrete repo rows owned by the selected authority and host', () => {
    const local = repo({ id: 'shared' })
    const runtime = repo({ id: 'shared', executionHostId: 'runtime:gpu' })
    const runtimeSsh = repo({
      id: 'nested',
      connectionId: 'builder',
      executionHostId: 'runtime:gpu'
    })
    const runtimeSelf = {
      authority: { kind: 'runtime' as const, environmentId: 'gpu', pairingRevision: 4 },
      destination: { selector: { kind: 'self' as const } },
      entry: entry()
    }
    expect(automationCreateEligibleProjects(runtimeSelf, [local, runtime, runtimeSsh], [])).toEqual(
      [runtime]
    )
    expect(
      automationCreateEligibleProjects(
        {
          ...runtimeSelf,
          destination: {
            selector: { kind: 'ssh' as const, targetId: 'builder', targetGeneration: 2 }
          }
        },
        [local, runtime, runtimeSsh],
        []
      )
    ).toEqual([runtimeSsh])
  })
})

describe('create workspace destination', () => {
  const runtimeSelf = {
    authority: { kind: 'runtime' as const, environmentId: 'gpu', pairingRevision: 4 },
    destination: { selector: { kind: 'self' as const } },
    entry: entry()
  }
  const runtimeRepo = {
    id: 'shared',
    displayName: 'orca',
    path: '/runtime/orca',
    badgeColor: '#000000',
    addedAt: 1,
    executionHostId: 'runtime:gpu'
  } as Repo

  function worktree(overrides: Partial<Worktree>): Worktree {
    return {
      id: 'shared::/runtime/orca',
      repoId: 'shared',
      displayName: 'main',
      path: '/runtime/orca',
      branch: 'main',
      ...overrides
    } as Worktree
  }

  it('keeps equal repo/workspace ids partitioned by runtime owner', () => {
    const local = worktree({ hostId: 'local' })
    const runtime = worktree({
      hostId: 'runtime:gpu',
      runtimeOwnerEnvironmentId: 'gpu'
    })
    const otherRuntime = worktree({
      hostId: 'runtime:other',
      runtimeOwnerEnvironmentId: 'other'
    })
    expect(
      automationCreateEligibleWorktrees(runtimeSelf, runtimeRepo, [local, runtime, otherRuntime])
    ).toEqual([runtime])
  })

  it('partitions nested SSH work by both authority and target', () => {
    const destination = {
      ...runtimeSelf,
      destination: {
        selector: { kind: 'ssh' as const, targetId: 'builder', targetGeneration: 2 }
      }
    }
    const repo = { ...runtimeRepo, connectionId: 'builder' }
    const owned = worktree({
      hostId: 'ssh:builder',
      runtimeOwnerEnvironmentId: 'gpu'
    })
    const desktop = worktree({ hostId: 'ssh:builder' })
    expect(automationCreateEligibleWorktrees(destination, repo, [owned, desktop])).toEqual([owned])
    expect(automationCreateWorkspaceRefreshHostId(destination)).toBe('runtime:gpu')
  })

  it('matches the run setup to the same destination', () => {
    const setup = {
      id: 'setup-runtime',
      projectId: 'project',
      repoId: 'shared',
      hostId: 'runtime:gpu',
      executionHostId: 'runtime:gpu',
      runtimeOwnerEnvironmentId: 'gpu',
      path: '/runtime/orca',
      displayName: 'orca',
      setupState: 'ready',
      setupMethod: 'cloned',
      createdAt: 1,
      updatedAt: 1
    } as ProjectHostSetup
    expect(automationCreateSetupMatchesDestination(setup, runtimeSelf)).toBe(true)
    expect(
      automationCreateSetupMatchesDestination(
        { ...setup, runtimeOwnerEnvironmentId: 'other', hostId: 'runtime:other' },
        runtimeSelf
      )
    ).toBe(false)
  })

  it('keeps folder workspaces pinned to the selected SSH host', () => {
    const destination = {
      authority: { kind: 'desktop' as const },
      destination: {
        selector: { kind: 'ssh' as const, targetId: 'builder', targetGeneration: 2 }
      },
      entry: entry()
    }
    const repo = { ...runtimeRepo, executionHostId: 'local' as const }
    const setup = {
      id: 'folder-builder',
      projectId: 'project',
      repoId: repo.id,
      hostId: 'ssh:builder',
      executionHostId: 'ssh:builder',
      path: '/builder/orca',
      displayName: 'orca',
      setupState: 'ready',
      setupMethod: 'imported-existing-folder',
      createdAt: 1,
      updatedAt: 1
    } as ProjectHostSetup
    const folder = worktree({
      hostId: 'ssh:builder',
      projectHostSetupId: setup.id,
      path: '/builder/orca'
    })
    expect(automationCreateEligibleProjects(destination, [repo], [setup])).toEqual([repo])
    expect(automationCreateEligibleWorktrees(destination, repo, [folder], [setup])).toEqual([
      folder
    ])
  })
})

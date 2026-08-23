import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  buildAutomationRunContextForDestination,
  buildAutomationRunContextForRepo
} from './automation-run-context'
import type { AutomationCreateDestination } from './automation-create-destination'

function repo(id: string, path = `/repos/${id}`): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1
  }
}

function setup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-builder',
    projectId: 'github:stablyai/orca',
    hostId: 'ssh:builder',
    repoId: 'repo-builder',
    path: '/remote/orca',
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('buildAutomationRunContextForRepo', () => {
  it('persists logical project and host setup identity for the selected run repo', () => {
    expect(
      buildAutomationRunContextForRepo({
        repoId: 'repo-builder',
        repos: [repo('repo-local', '/local/orca'), repo('repo-builder', '/remote/orca')],
        projectHostSetups: [
          setup({
            id: 'setup-local',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/local/orca'
          }),
          setup()
        ]
      })
    ).toEqual({
      kind: 'workspace-run',
      projectId: 'github:stablyai/orca',
      hostId: 'ssh:builder',
      projectHostSetupId: 'setup-builder',
      repoId: 'repo-builder',
      path: '/remote/orca'
    })
  })

  it('does not build a run context for missing or not-ready setups', () => {
    expect(
      buildAutomationRunContextForRepo({
        repoId: 'repo-builder',
        repos: [repo('repo-builder')],
        projectHostSetups: [setup({ setupState: 'setting-up' })]
      })
    ).toBeNull()

    expect(
      buildAutomationRunContextForRepo({
        repoId: 'repo-builder',
        repos: [],
        projectHostSetups: [setup()]
      })
    ).toBeNull()
  })
})

describe('buildAutomationRunContextForDestination', () => {
  const destination = {
    authority: { kind: 'runtime' as const, environmentId: 'gpu', pairingRevision: 4 },
    destination: { selector: { kind: 'self' as const } },
    entry: {} as AutomationCreateDestination['entry']
  }

  it('does not borrow a same-repo setup from another host', () => {
    const local = setup({
      id: 'setup-local',
      hostId: 'local',
      repoId: 'repo-builder',
      path: '/local/orca'
    })
    const runtime = setup({
      id: 'setup-runtime',
      hostId: 'runtime:gpu',
      executionHostId: 'runtime:gpu',
      runtimeOwnerEnvironmentId: 'gpu',
      repoId: 'repo-builder',
      path: '/runtime/orca'
    })
    expect(
      buildAutomationRunContextForDestination({
        repoId: 'repo-builder',
        destination,
        projectHostSetups: [local, runtime]
      })
    ).toMatchObject({
      hostId: 'runtime:gpu',
      projectHostSetupId: 'setup-runtime',
      path: '/runtime/orca'
    })
  })
})

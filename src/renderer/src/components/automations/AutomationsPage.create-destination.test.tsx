// @vitest-environment happy-dom

/**
 * Where a new automation lands.
 *
 * Every case here is one the page previously answered by inferring a host from
 * the draft's run context: the storage authority came from whichever machine the
 * workspace happened to execute on, which is exactly what required invariant 1
 * forbids. These pin the stated-destination contract instead — the destination
 * is chosen, shown, re-checked at submit, and refused when it no longer holds.
 */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { hostStableKey } from '../../../../shared/automation-owner-key'
import type { AutomationListRow } from './automation-list-row-identity'
import {
  api,
  installAutomationsPageHarness,
  listedRow,
  mocks,
  renderPage,
  runtimeHost,
  RUNTIME_ID,
  RUNTIME_SELF_FILTER,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, REPO_ID, WORKSPACE_ID } from './automations-page-fixtures'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

installAutomationsPageHarness()

const RUNTIME_REPO_ID = 'repo-2'
const RUNTIME_WORKSPACE_ID = 'workspace-2'
const SSH_TARGET_ID = 'ssh-target-1'
const SSH_REPO_ID = 'repo-ssh'
const SSH_HOST_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'ssh', targetId: SSH_TARGET_ID }
})

const DESKTOP_SELF_KEY = hostStableKey({
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
})
const RUNTIME_SELF_KEY = hostStableKey({
  authority: { kind: 'runtime', environmentId: RUNTIME_ID },
  selector: { kind: 'self' }
})
const RUNTIME_SSH_KEY = hostStableKey({
  authority: { kind: 'runtime', environmentId: RUNTIME_ID },
  selector: { kind: 'ssh', targetId: SSH_TARGET_ID }
})

/**
 * A project the runtime owns. It carries no `connectionId`, so a flat repo
 * lookup reads it as local — the ambiguity the authority-scoped tables exist to
 * remove.
 */
function addRuntimeProject(): void {
  const repo = {
    id: RUNTIME_REPO_ID,
    displayName: 'gpu-orca',
    path: '/repos/gpu-orca',
    badgeColor: '#111111',
    addedAt: 1,
    worktreeBaseRef: 'main',
    executionHostId: `runtime:${RUNTIME_ID}`
  } as Repo
  const worktree = {
    id: RUNTIME_WORKSPACE_ID,
    repoId: RUNTIME_REPO_ID,
    displayName: 'main',
    path: '/repos/gpu-orca',
    branch: 'main',
    hostId: `runtime:${RUNTIME_ID}`,
    runtimeOwnerEnvironmentId: RUNTIME_ID,
    projectHostSetupId: 'setup-2'
  } as unknown as Worktree
  const setup: ProjectHostSetup = {
    id: 'setup-2',
    projectId: 'project-2',
    hostId: `runtime:${RUNTIME_ID}`,
    repoId: RUNTIME_REPO_ID,
    path: '/repos/gpu-orca',
    displayName: 'gpu-orca',
    runtimeOwnerEnvironmentId: RUNTIME_ID,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
  const repos = mocks.state.repos as Repo[]
  const setups = mocks.state.projectHostSetups as ProjectHostSetup[]
  const worktreesByRepo = mocks.state.worktreesByRepo as Record<string, Worktree[]>
  mocks.state.repos = [...repos, repo]
  mocks.state.projectHostSetups = [...setups, setup]
  mocks.state.worktreesByRepo = { ...worktreesByRepo, [RUNTIME_REPO_ID]: [worktree] }
  mocks.repoMap.set(RUNTIME_REPO_ID, repo)
  mocks.worktreeMap.set(RUNTIME_WORKSPACE_ID, worktree)
}

/** A desktop-registered SSH host, with the generation that makes it fenceable. */
function addSshHost(): void {
  mocks.state.sshTargetLabels = new Map([[SSH_TARGET_ID, 'openclaw']])
  mocks.state.sshTargetGenerations = new Map([[SSH_TARGET_ID, 1]])
  mocks.state.sshConnectionStates = new Map([[SSH_TARGET_ID, { status: 'connected' }]])
}

/** A project checked out on that SSH host rather than locally. */
function addSshProject(): void {
  const repo = {
    id: SSH_REPO_ID,
    displayName: 'orca',
    path: '/repos/orca',
    badgeColor: '#222222',
    addedAt: 1,
    worktreeBaseRef: 'main',
    connectionId: SSH_TARGET_ID
  } as Repo
  mocks.state.repos = [...(mocks.state.repos as Repo[]), repo]
  mocks.repoMap.set(SSH_REPO_ID, repo)
}

function addRuntimeSshProject(): void {
  const repo = {
    id: 'repo-runtime-ssh',
    displayName: 'runtime-builder',
    path: '/repos/runtime-builder',
    badgeColor: '#333333',
    addedAt: 1,
    connectionId: SSH_TARGET_ID,
    executionHostId: `runtime:${RUNTIME_ID}`
  } as Repo
  const worktree = {
    id: 'workspace-runtime-ssh',
    repoId: repo.id,
    displayName: 'main',
    path: repo.path,
    branch: 'main',
    hostId: `ssh:${SSH_TARGET_ID}`,
    runtimeOwnerEnvironmentId: RUNTIME_ID
  } as unknown as Worktree
  mocks.state.repos = [...(mocks.state.repos as Repo[]), repo]
  mocks.state.worktreesByRepo = {
    ...(mocks.state.worktreesByRepo as Record<string, Worktree[]>),
    [repo.id]: [worktree]
  }
  mocks.state.sshStateByEnvironment = new Map([
    [
      RUNTIME_ID,
      {
        connectionStates: new Map([[SSH_TARGET_ID, { status: 'connected' }]]),
        targetLabels: new Map([[SSH_TARGET_ID, 'runtime builder']]),
        targetGenerations: new Map([[SSH_TARGET_ID, 2]]),
        removedTargetLabels: new Map(),
        targetsHydrated: true
      }
    ]
  ])
  mocks.state.activeWorktreeId = worktree.id
  mocks.repoMap.set(repo.id, repo)
  mocks.worktreeMap.set(worktree.id, worktree)
}

/** The runtime answers a create; without this the RPC double returns an empty result. */
function runtimeCreateReturns(automation: Automation): void {
  const previous = mocks.callRuntimeRpc.getMockImplementation()
  mocks.callRuntimeRpc.mockImplementation(
    async (target: unknown, method: string, params: unknown, options: unknown) => {
      if (method === 'automation.create') {
        return { automation }
      }
      return await previous?.(target, method, params, options)
    }
  )
}

async function openCreateDialogFor(projectId: string, workspaceId: string): Promise<void> {
  await act(async () => {
    mocks.listPanel?.openCreateDialog()
  })
  await act(async () => {
    mocks.editorDialog?.onDraftChange((current) => ({
      ...(current as Record<string, unknown>),
      name: 'Sweep',
      prompt: 'Do the sweep',
      projectId,
      workspaceMode: 'existing',
      workspaceId
    }))
  })
}

async function save(): Promise<void> {
  await act(async () => {
    mocks.editorDialog?.onSave()
  })
}

function runtimeCreateCalls(): unknown[][] {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'automation.create')
}

describe('AutomationsPage create destination', () => {
  it('creates on the selected runtime rather than under the desktop authority', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
    await save()

    // The desktop is the client's own authority, never the selected host.
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(runtimeCreateCalls()).toHaveLength(1)
    expect(runtimeCreateCalls()[0]?.[2]).toMatchObject({
      destination: { selector: { kind: 'self' } }
    })
  })

  it('refuses a runtime-owned project under the desktop destination', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addRuntimeProject()

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
    await save()

    // A repo with no connection ID is not evidence of local: this one is the
    // runtime's, and the desktop's Self host cannot hold an automation for it.
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })

  it('requires an explicit host choice when All hosts spans more than one host', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    addRuntimeProject()

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    await save()

    expect(api.automations.create).not.toHaveBeenCalled()
    expect(runtimeCreateCalls()).toHaveLength(0)
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.createDestination?.entries.map((entry) => entry.stableKey)).toEqual(
      expect.arrayContaining([DESKTOP_SELF_KEY, RUNTIME_SELF_KEY])
    )

    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(RUNTIME_SELF_KEY)
    })
    expect(mocks.editorDialog?.createDestination?.resolution.status).toBe('ready')
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
    await save()

    expect(runtimeCreateCalls()).toHaveLength(1)
    expect(api.automations.create).not.toHaveBeenCalled()
  })

  it('prefills Runtime + SSH from the active qualified workspace', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    addSshHost()
    addRuntimeSshProject()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })

    const resolution = mocks.editorDialog?.createDestination?.resolution
    expect(resolution?.status === 'ready' && resolution.entry.stableKey).toBe(RUNTIME_SSH_KEY)
    expect(resolution?.status === 'ready' && resolution.entry.stableKey).not.toBe(SSH_HOST_KEY)
  })

  it('offers only the projects the chosen host actually has', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()
    addSshProject()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })

    // The local project shares this one's name, so offering both leaves the user
    // no way to tell which is the one on that host.
    expect(mocks.editorDialog?.repos?.map((repo) => repo.id)).toEqual([SSH_REPO_ID])
  })

  it('offers only workspaces verified on the chosen runtime', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    const bucket = (mocks.state.worktreesByRepo as Record<string, Worktree[]>)[RUNTIME_REPO_ID]!
    const foreign = {
      ...bucket[0],
      id: 'foreign-workspace',
      displayName: 'foreign',
      hostId: 'local',
      runtimeOwnerEnvironmentId: undefined
    } as Worktree
    bucket.push(foreign)

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
    await settleHostQueries()

    expect(mocks.editorDialog?.worktrees?.map((worktree) => worktree.id)).toEqual([
      RUNTIME_WORKSPACE_ID
    ])
  })

  it('rejects an injected workspace from another host before runtime create', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    const bucket = (mocks.state.worktreesByRepo as Record<string, Worktree[]>)[RUNTIME_REPO_ID]!
    const foreign = {
      ...bucket[0],
      id: 'foreign-workspace',
      displayName: 'foreign',
      hostId: 'local',
      runtimeOwnerEnvironmentId: undefined
    } as Worktree
    bucket.push(foreign)

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, foreign.id)
    await save()

    expect(runtimeCreateCalls()).toHaveLength(0)
    expect(mocks.toastError).toHaveBeenCalledWith('Choose an available workspace before saving.')
  })

  it('does not offer or save remembered workspaces when the host cannot verify them', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    mocks.state.fetchWorktrees = vi.fn(async () => false)

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)
    await settleHostQueries()

    expect(mocks.editorDialog?.worktrees).toEqual([])
    await save()
    expect(runtimeCreateCalls()).toHaveLength(0)
    expect(mocks.editorDialog?.notice?.message).toContain("couldn't verify workspaces")
  })

  it('moves a stranded project to one the newly chosen host has', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()
    addSshProject()

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    expect(mocks.editorDialog?.draft?.projectId).toBe(REPO_ID)

    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })

    // Keeping the local project selected only defers the same refusal to submit.
    expect(mocks.editorDialog?.draft?.projectId).toBe(SSH_REPO_ID)
  })

  it('offers nothing rather than a stranded project when the host has no projects', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    addSshHost()

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      mocks.listPanel?.openCreateDialog()
    })
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(SSH_HOST_KEY)
    })

    expect(mocks.editorDialog?.repos).toEqual([])
    // Nothing is left selected to submit against a host that cannot hold it.
    expect(mocks.editorDialog?.draft?.projectId).toBe('')
  })

  it('states the chosen host on the form before submit', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])

    await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(REPO_ID, WORKSPACE_ID)
    await act(async () => {
      mocks.editorDialog?.createDestination?.onSelect(RUNTIME_SELF_KEY)
    })

    const resolution = mocks.editorDialog?.createDestination?.resolution
    // The owner shown is the storage authority, not the workspace's run host.
    expect(resolution?.status === 'ready' && resolution.entry.stableKey).toBe(RUNTIME_SELF_KEY)
    expect(resolution?.status === 'ready' && resolution.authority).toEqual({
      kind: 'runtime',
      environmentId: RUNTIME_ID,
      pairingRevision: 4
    })
  })

  it('fails closed when the destination host changes incarnation while the form is open', async () => {
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([], [])
    runtimeCreateReturns(makeAutomation({ id: 'a-new', name: 'Sweep' }))
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER

    const { rerender } = await renderPage()
    await settleHostQueries()
    await openCreateDialogFor(RUNTIME_REPO_ID, RUNTIME_WORKSPACE_ID)

    // The host re-paired while the form was open: same stable key, new owner.
    mocks.state.runtimeEnvironments = [
      { id: RUNTIME_ID, name: 'GPU box', createdAt: 1, pairingRevision: 9 }
    ]
    await rerender()
    await save()

    expect(runtimeCreateCalls()).toHaveLength(0)
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(mocks.editorDialog?.notice?.message).toBeTruthy()
    expect(mocks.editorDialog?.open).toBe(true)
  })
})

describe('AutomationsPage edit fencing', () => {
  async function editAndSave(row: AutomationListRow): Promise<void> {
    await act(async () => {
      void mocks.listPanel?.openEditDialog(row)
    })
    await act(async () => {
      mocks.editorDialog?.onDraftChange((current) => ({
        ...(current as Record<string, unknown>),
        name: 'Renamed'
      }))
    })
    await save()
  }

  function updatePreconditions(): unknown[] {
    return api.automations.update.mock.calls.map(
      ([payload]) => (payload as { expectedOwner?: unknown }).expectedOwner
    )
  }

  it('offers only workspaces verified on the edited automation’s runtime', async () => {
    const automation = makeAutomation({
      id: 'a-runtime',
      projectId: RUNTIME_REPO_ID,
      workspaceId: RUNTIME_WORKSPACE_ID,
      workspaceMode: 'existing'
    })
    api.automations.list.mockResolvedValue([])
    scopedList([])
    runtimeHost([automation], [])
    addRuntimeProject()
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    const bucket = (mocks.state.worktreesByRepo as Record<string, Worktree[]>)[RUNTIME_REPO_ID]!
    bucket.push({
      ...bucket[0],
      id: 'foreign-workspace',
      displayName: 'foreign',
      hostId: 'local',
      runtimeOwnerEnvironmentId: undefined
    } as Worktree)

    await renderPage()
    await settleHostQueries()
    await act(async () => {
      void mocks.listPanel?.openEditDialog(listedRow(automation.id))
    })
    await settleHostQueries()

    expect(mocks.editorDialog?.repos?.map((repo) => repo.id)).toEqual([RUNTIME_REPO_ID])
    expect(mocks.editorDialog?.worktrees?.map((worktree) => worktree.id)).toEqual([
      RUNTIME_WORKSPACE_ID
    ])
  })

  it('fences the save even when the record cannot be re-read', async () => {
    const automation = makeAutomation({ id: 'a-1' })
    api.automations.list.mockResolvedValue([])
    scopedList([automation])

    await renderPage()
    await settleHostQueries()
    // The row is gone from its host by the time the form is saved.
    scopedList([])
    await editAndSave(listedRow(automation.id))

    expect(api.automations.update).toHaveBeenCalled()
    expect(updatePreconditions()).not.toContain(undefined)
  })
})

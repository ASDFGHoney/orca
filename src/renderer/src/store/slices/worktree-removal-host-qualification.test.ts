/**
 * STA-4448: a destructive workspace removal must land on the host whose row the
 * user confirmed — never on whichever host routing happens to prefer.
 *
 * A workspace id is `repoId::path` with no host component, so the local host, an
 * SSH host and a paired runtime can all publish the SAME id. Removal routing
 * short-circuits to the ACTIVE workspace's host (`resolveActiveWorkspaceRoute`),
 * and `state.activeWorktreeId === worktreeId` is true for a colliding id no
 * matter which row was confirmed. Confirming the remote row therefore issued the
 * destructive call against the LOCAL checkout and destroyed its uncommitted
 * work, while the row the user picked survived.
 *
 * The fix makes host qualification MANDATORY at `removeWorktree` — the one
 * chokepoint every delete entry point funnels through — and fails closed rather
 * than rerouting. Rerouting a colliding row to its right host is #14606's job.
 *
 * Rig: one REAL temp directory per host stands in for that host's checkout, each
 * holding a marker file. The transports (`worktrees.remove` for local/SSH,
 * `runtimeEnvironments.call` for a paired runtime) are the only fakes, and they
 * ACTUALLY delete the directory of whichever host they are routed to. The gate
 * is filesystem state, not call arguments. The single-host controls delete for
 * real through the same rig, so a passing refusal assertion cannot come from a
 * rig that never deletes anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'
import {
  cleanupHostCheckouts,
  createHostCheckout,
  installRemovalTransports as installTransports,
  COLLIDING_WORKTREE_ID as WORKTREE_ID,
  COLLIDING_WORKTREE_PATH as WORKTREE_PATH,
  HOST_COLLISION_MESSAGE,
  HOST_UNRESOLVED_MESSAGE,
  LOCAL_HOST,
  RELAY_HOST,
  SSH_HOST
} from './worktree-removal-host-collision-fixture'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

const FOLDER_WORKSPACE_ID = 'folder:fw-1'

function installRemovalTransports(
  rootsByHostId: Partial<Record<ExecutionHostId, string>>,
  routedHostIds: string[]
): void {
  installTransports(
    { remove: mockApi.worktrees.remove, runtimeCall: runtimeEnvironmentCall },
    rootsByHostId,
    routedHostIds
  )
}

function rowOnHost(hostId: ExecutionHostId) {
  return makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: WORKTREE_PATH, hostId })
}

function seedHosts(
  store: ReturnType<typeof createTestStore>,
  rows: readonly ReturnType<typeof rowOnHost>[],
  extra: Partial<AppState> = {}
): void {
  store.setState({
    repos: [{ id: 'repo1', path: '/repo1', displayName: 'Repo 1', executionHostId: LOCAL_HOST }],
    worktreesByRepo: { repo1: [...rows] },
    ...extra
  } as Partial<AppState>)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})

afterEach(cleanupHostCheckouts)

describe('STA-4448: a colliding id cannot delete the host the user did not confirm', () => {
  it.each([
    { label: 'a normal delete', force: false, options: undefined },
    {
      label: 'an explicit force delete',
      force: true,
      options: { allowUnverifiedPtyStop: true } as const
    }
  ])(
    'leaves the ACTIVE local checkout on disk when $label confirms the SSH row',
    async ({ force, options }) => {
      const local = createHostCheckout(LOCAL_HOST)
      const ssh = createHostCheckout(SSH_HOST)
      const routedHostIds: string[] = []
      installRemovalTransports({ [LOCAL_HOST]: local.root, [SSH_HOST]: ssh.root }, routedHostIds)

      const store = createTestStore()
      // The user opened the LOCAL workspace, so removal routing prefers local.
      seedHosts(store, [rowOnHost(LOCAL_HOST), rowOnHost(SSH_HOST)], {
        activeWorktreeId: WORKTREE_ID,
        activeWorkspaceExecutionHostId: LOCAL_HOST
      } as Partial<AppState>)

      // The user right-clicked the SSH row and confirmed its deletion.
      const result = await store
        .getState()
        .removeWorktree({ id: WORKTREE_ID, executionHostId: SSH_HOST }, force, options)

      expect(
        fs.existsSync(local.markerPath),
        `the ACTIVE local checkout must survive confirming the SSH row; removal was routed to hostId=${routedHostIds.join(',') || '<none>'}`
      ).toBe(true)
      // Fail closed, do not reroute: rerouting the colliding row is #14606's job.
      expect(fs.existsSync(ssh.markerPath)).toBe(true)
      expect(routedHostIds).toEqual([])
      expect(result).toEqual({ ok: false, error: HOST_COLLISION_MESSAGE })
    }
  )

  it('leaves the ACTIVE local checkout on disk when a paired-runtime row is confirmed', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const relay = createHostCheckout(RELAY_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports({ [LOCAL_HOST]: local.root, [RELAY_HOST]: relay.root }, routedHostIds)

    const store = createTestStore()
    seedHosts(store, [rowOnHost(LOCAL_HOST), rowOnHost(RELAY_HOST)], {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: LOCAL_HOST
    } as Partial<AppState>)

    const result = await store
      .getState()
      .removeWorktree({ id: WORKTREE_ID, executionHostId: RELAY_HOST })

    expect(fs.existsSync(local.markerPath), 'the ACTIVE local checkout must survive').toBe(true)
    expect(fs.existsSync(relay.markerPath)).toBe(true)
    expect(routedHostIds).toEqual([])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: HOST_COLLISION_MESSAGE })
  })

  it('refuses a caller that omits the host while the id collides across hosts', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const ssh = createHostCheckout(SSH_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports({ [LOCAL_HOST]: local.root, [SSH_HOST]: ssh.root }, routedHostIds)

    const store = createTestStore()
    seedHosts(store, [rowOnHost(LOCAL_HOST), rowOnHost(SSH_HOST)], {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: LOCAL_HOST
    } as Partial<AppState>)

    // An unqualified target is the shape #14606's optional contract allowed any
    // caller to send; it must not be able to resolve a collision by omission.
    const result = await store
      .getState()
      .removeWorktree({ id: WORKTREE_ID, executionHostId: null }, true, {
        allowUnverifiedPtyStop: true
      })

    expect(fs.existsSync(local.markerPath)).toBe(true)
    expect(fs.existsSync(ssh.markerPath)).toBe(true)
    expect(routedHostIds).toEqual([])
    expect(result).toEqual({ ok: false, error: HOST_COLLISION_MESSAGE })
  })

  it('refuses a confirmed host that no longer owns the id', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports({ [LOCAL_HOST]: local.root }, routedHostIds)

    const store = createTestStore()
    // The SSH row is gone from the refreshed list, but its removal was confirmed.
    seedHosts(store, [rowOnHost(LOCAL_HOST)])

    const result = await store
      .getState()
      .removeWorktree({ id: WORKTREE_ID, executionHostId: SSH_HOST })

    expect(fs.existsSync(local.markerPath), 'the local checkout must survive').toBe(true)
    expect(routedHostIds).toEqual([])
    expect(result).toEqual({ ok: false, error: HOST_UNRESOLVED_MESSAGE })
  })

  it('keeps forget-local available on a colliding id and touches no files', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const ssh = createHostCheckout(SSH_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports({ [LOCAL_HOST]: local.root, [SSH_HOST]: ssh.root }, routedHostIds)
    mockApi.worktrees.forgetLocal.mockResolvedValue({})

    const store = createTestStore()
    seedHosts(store, [rowOnHost(LOCAL_HOST), rowOnHost(SSH_HOST)], {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: LOCAL_HOST
    } as Partial<AppState>)

    const result = await store
      .getState()
      .removeWorktree({ id: WORKTREE_ID, executionHostId: SSH_HOST }, false, {
        mode: 'forget-local'
      })

    // forget-local drops Orca's records only, so it stays available precisely
    // when the owning host is gone and routing can no longer resolve.
    expect(result).toEqual({ ok: true })
    expect(fs.existsSync(local.markerPath)).toBe(true)
    expect(fs.existsSync(ssh.markerPath)).toBe(true)
    expect(routedHostIds).toEqual([])
    expect(mockApi.worktrees.forgetLocal).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WORKTREE_ID, hostId: SSH_HOST })
    )
  })
})

describe('a refused removal must not strand the row on a "Deleting…" spinner', () => {
  it.each([
    {
      label: 'the wrong-host refusal',
      seedRows: () => [rowOnHost(LOCAL_HOST), rowOnHost(SSH_HOST)],
      target: { id: WORKTREE_ID, executionHostId: SSH_HOST } as const
    },
    {
      label: 'the unresolvable-route refusal',
      seedRows: () => [rowOnHost(LOCAL_HOST), rowOnHost(SSH_HOST)],
      target: { id: WORKTREE_ID, executionHostId: null } as const
    }
  ])('clears the delete state after $label', async ({ seedRows, target }) => {
    const store = createTestStore()
    seedHosts(store, seedRows(), {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: LOCAL_HOST
    } as Partial<AppState>)

    // Callers mark rows deleting up front so the sidebar shows progress immediately.
    store.getState().markWorktreesDeleting([WORKTREE_ID])
    expect(store.getState().deleteStateByWorktreeId[WORKTREE_ID]?.isDeleting).toBe(true)

    const result = await store.getState().removeWorktree(target, false, undefined)

    expect(result.ok).toBe(false)
    // Why: the refusal returns before removeWorktree's try/catch, so without an
    // explicit clear the row keeps spinning long after the toast auto-dismisses.
    expect(store.getState().deleteStateByWorktreeId[WORKTREE_ID]?.isDeleting).toBeFalsy()
  })
})

describe('STA-4448: ordinary single-host deletion still deletes for real', () => {
  it.each([
    { label: 'a normal delete', force: false, options: undefined },
    {
      label: 'an explicit force delete',
      force: true,
      options: { allowUnverifiedPtyStop: true } as const
    }
  ])('deletes the confirmed local checkout through $label', async ({ force, options }) => {
    const local = createHostCheckout(LOCAL_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports({ [LOCAL_HOST]: local.root }, routedHostIds)

    const store = createTestStore()
    seedHosts(store, [rowOnHost(LOCAL_HOST)], {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: LOCAL_HOST
    } as Partial<AppState>)

    const result = await store
      .getState()
      .removeWorktree({ id: WORKTREE_ID, executionHostId: LOCAL_HOST }, force, options)

    expect(result).toEqual({ ok: true })
    expect(routedHostIds).toEqual([LOCAL_HOST])
    expect(fs.existsSync(local.markerPath)).toBe(false)
  })

  it('deletes the confirmed SSH checkout for real', async () => {
    const ssh = createHostCheckout(SSH_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports({ [SSH_HOST]: ssh.root }, routedHostIds)

    const store = createTestStore()
    seedHosts(store, [rowOnHost(SSH_HOST)])

    const result = await store
      .getState()
      .removeWorktree({ id: WORKTREE_ID, executionHostId: SSH_HOST })

    expect(result).toEqual({ ok: true })
    expect(routedHostIds).toEqual([SSH_HOST])
    expect(fs.existsSync(ssh.markerPath)).toBe(false)
  })

  it('deletes the confirmed paired-runtime checkout through its runtime transport', async () => {
    const relay = createHostCheckout(RELAY_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports({ [RELAY_HOST]: relay.root }, routedHostIds)

    const store = createTestStore()
    seedHosts(store, [rowOnHost(RELAY_HOST)], {
      settings: { activeRuntimeEnvironmentId: 'env-1' }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .removeWorktree({ id: WORKTREE_ID, executionHostId: RELAY_HOST })

    expect(result).toEqual({ ok: true })
    expect(routedHostIds).toEqual([RELAY_HOST])
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
    expect(fs.existsSync(relay.markerPath)).toBe(false)
  })

  it('deletes a pre-host-qualified row that declares no host at all', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports({ [LOCAL_HOST]: local.root }, routedHostIds)

    const store = createTestStore()
    // Snapshot/legacy rows publish no hostId; the repo's host still routes them.
    seedHosts(store, [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: WORKTREE_PATH })])

    const result = await store.getState().removeWorktree({ id: WORKTREE_ID, executionHostId: null })

    expect(result).toEqual({ ok: true })
    expect(routedHostIds).toEqual([LOCAL_HOST])
    expect(fs.existsSync(local.markerPath)).toBe(false)
  })

  it('deletes a folder workspace, which is not a git worktree at all', async () => {
    const local = createHostCheckout(LOCAL_HOST)
    const routedHostIds: string[] = []
    installRemovalTransports({ [LOCAL_HOST]: local.root }, routedHostIds)

    const store = createTestStore()
    store.setState({
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [{ id: 'fw-1', executionHostId: LOCAL_HOST }]
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .removeWorktree({ id: FOLDER_WORKSPACE_ID, executionHostId: LOCAL_HOST }, true, {
        allowUnverifiedPtyStop: true
      })

    expect(result).toEqual({ ok: true })
    expect(routedHostIds).toEqual([LOCAL_HOST])
    expect(fs.existsSync(local.markerPath)).toBe(false)
  })
})

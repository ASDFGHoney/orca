import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../../../shared/automation-owner-conflict'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'

const callRuntimeRpc = vi.fn()
const getRuntimeEnvironmentStatus = vi.fn()

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args),
  getRuntimeEnvironmentStatus: (...args: unknown[]) => getRuntimeEnvironmentStatus(...args),
  // Why: the real matcher is exercised in runtime-rpc-result's own tests; here it only needs to be honest about the tail token.
  hasRuntimeRpcErrorCode: (error: unknown, code: string) =>
    typeof (error as { message?: unknown })?.message === 'string' &&
    (error as { message: string }).message.trimEnd().endsWith(`: ${code}`)
}))

const listScoped = vi.fn()
const update = vi.fn()
const remove = vi.fn()
const listRuns = vi.fn()

const DESKTOP = { kind: 'desktop' } as const
const RUNTIME = { kind: 'runtime', environmentId: 'env-1', pairingRevision: 4 } as const
const SSH_OWNER = {
  authority: RUNTIME,
  selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 }
} as const
const SELF_OWNER = { authority: RUNTIME, selector: { kind: 'self' } } as const

const ALL_CAPABILITIES = {
  capabilities: [
    AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
    AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY
  ]
}

beforeEach(() => {
  callRuntimeRpc.mockReset()
  getRuntimeEnvironmentStatus.mockReset()
  listScoped.mockReset()
  update.mockReset()
  remove.mockReset()
  listRuns.mockReset()
  vi.stubGlobal('window', {
    api: { automations: { listScoped, update, delete: remove, listRuns } }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function client() {
  return await import('./automation-scoped-list-client')
}

describe('listScopedAutomations', () => {
  it('rejects a legacy-shaped payload instead of committing it as one host', async () => {
    const { listScopedAutomations, AutomationHostScopeUnsupportedError } = await client()
    listScoped.mockResolvedValue({ automations: [{ id: 'a1' }] })
    await expect(listScopedAutomations(DESKTOP, { kind: 'self' })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
  })

  it('rejects a structurally broken payload', async () => {
    const { listScopedAutomations, AutomationListResponseError } = await client()
    listScoped.mockResolvedValue({ automations: 'nope' })
    await expect(listScopedAutomations(DESKTOP, { kind: 'self' })).rejects.toBeInstanceOf(
      AutomationListResponseError
    )
  })

  it('drops rows the host scoped elsewhere and keeps the rest', async () => {
    const { listScopedAutomations } = await client()
    listScoped.mockResolvedValue({
      automations: [{ id: 'a1' }, { id: 'a2' }],
      items: [
        { automationId: 'a1', selector: { kind: 'ssh', targetId: 'other', targetGeneration: 1 } },
        { automationId: 'a2', selector: { kind: 'self' } }
      ],
      orphanCount: 2
    })
    const result = await listScopedAutomations(DESKTOP, { kind: 'self' })
    expect(result.automations.map((entry) => entry.id)).toEqual(['a2'])
    expect(result.invalidRows).toBe(1)
    expect(result.orphanCount).toBe(2)
  })

  it('negotiates host scope and pins the request to the captured pairing revision', async () => {
    const { listScopedAutomations } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
    await listScopedAutomations(RUNTIME, {
      kind: 'ssh',
      targetId: 'ssh-1',
      expectedTargetGeneration: 7
    })
    expect(getRuntimeEnvironmentStatus).toHaveBeenCalledWith('env-1', expect.any(Number))
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.list',
      { selector: { kind: 'ssh', targetId: 'ssh-1', expectedTargetGeneration: 7 } },
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
  })

  it('surfaces a stale pairing revision instead of retrying unfenced', async () => {
    const { listScopedAutomations } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockRejectedValue(new Error('runtime_environment_revision_changed'))
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).rejects.toThrow(
      'runtime_environment_revision_changed'
    )
  })

  it('does not query a host that never advertised host scope', async () => {
    const { listScopedAutomations, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities: [] })
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  // An unreachable host proves nothing about its version, so it must not be reported as too old.
  it('propagates an unreachable authority instead of calling it incompatible', async () => {
    const { listScopedAutomations, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockRejectedValue(new Error('runtime_unavailable'))
    await expect(listScopedAutomations(RUNTIME, { kind: 'self' })).rejects.not.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
  })
})

describe('listAutomationsForOwner', () => {
  // Rule: never trust a scoped list from a server that ignored the selector.
  // The Self read degrades to the unscoped list plus a client-side partition.
  it('falls back to an unscoped Self read on a host without host scoping', async () => {
    const { listAutomationsForOwner } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities: [] })
    callRuntimeRpc.mockResolvedValue({
      automations: [
        { id: 'a1', executionTargetType: 'local' },
        { id: 'a2', executionTargetType: 'ssh', executionTargetId: 't1' },
        { id: 'a3', executionTargetType: 'local', schedulerOwner: 'remote_host_service' }
      ]
    })
    const result = await listAutomationsForOwner(SELF_OWNER)
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.list',
      null,
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
    expect(result.automations.map((automation) => automation.id)).toEqual(['a1'])
    expect(result.items).toEqual([{ automationId: 'a1', selector: { kind: 'self' } }])
  })

  it('keeps failing closed for an SSH owner on a host without host scoping', async () => {
    const { listAutomationsForOwner, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities: [] })
    await expect(listAutomationsForOwner(SSH_OWNER)).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('keeps the scoped read on a capable host', async () => {
    const { listAutomationsForOwner } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automations: [], items: [], orphanCount: 0 })
    await listAutomationsForOwner(SELF_OWNER)
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.list',
      { selector: { kind: 'self' } },
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
  })
})

describe('owner-fenced mutations', () => {
  it('sends the captured owner with the mutation', async () => {
    const { updateAutomationForOwner } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
    await updateAutomationForOwner(SSH_OWNER, 'a1', { enabled: false })
    expect(callRuntimeRpc.mock.calls[0]?.[2]).toEqual({
      id: 'a1',
      updates: { enabled: false },
      expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } },
      destination: undefined
    })
  })

  it('stays view-only against a host without owner fencing', async () => {
    const { updateAutomationForOwner, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue({
      capabilities: [AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY]
    })
    await expect(
      updateAutomationForOwner(SSH_OWNER, 'a1', { enabled: false })
    ).rejects.toBeInstanceOf(AutomationHostScopeUnsupportedError)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  // Self records live on the answering authority and mutate by id under the
  // pairing-revision fence, so a pre-fencing server stays fully usable for them.
  it('mutates Self on a runtime without owner fencing instead of failing closed', async () => {
    const { deleteAutomationForOwner, runAutomationNowForOwner, updateAutomationForOwner } =
      await client()
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' }, run: { id: 'r1' } })
    await updateAutomationForOwner(SELF_OWNER, 'a1', { enabled: false })
    await deleteAutomationForOwner(SELF_OWNER, 'a1')
    await runAutomationNowForOwner(SELF_OWNER, 'a1')
    expect(getRuntimeEnvironmentStatus).not.toHaveBeenCalled()
    expect(callRuntimeRpc.mock.calls[0]?.[2]).toEqual({
      id: 'a1',
      updates: { enabled: false },
      expectedOwner: { selector: { kind: 'self' } },
      destination: undefined
    })
    expect(callRuntimeRpc.mock.calls.map((call) => call[3])).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
      )
    )
  })

  // An old server ignores `destination` and would silently leave the record in
  // place, so a Self move still needs the fenced contract.
  it('still fails a Self destination move closed on a host without owner fencing', async () => {
    const { updateAutomationForOwner, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue({
      capabilities: [AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY]
    })
    await expect(
      updateAutomationForOwner(SELF_OWNER, 'a1', { enabled: false }, { selector: { kind: 'self' } })
    ).rejects.toBeInstanceOf(AutomationHostScopeUnsupportedError)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('creates at a Self destination without probing for owner fencing', async () => {
    const { createAutomationForDestination } = await client()
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
    await createAutomationForDestination(
      RUNTIME,
      { name: 'n', prompt: 'p', projectId: 'repo-1' } as never,
      { selector: { kind: 'self' } }
    )
    expect(getRuntimeEnvironmentStatus).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('sends an existing workspace as an id: selector on the runtime', async () => {
    const { createAutomationForDestination } = await client()
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })
    await createAutomationForDestination(
      RUNTIME,
      {
        name: 'n',
        prompt: 'p',
        projectId: 'repo-1',
        workspaceMode: 'existing',
        workspaceId: 'repo-1::/tmp/orca/feature'
      } as never,
      { selector: { kind: 'self' } }
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.create',
      expect.objectContaining({
        repo: 'repo-1',
        workspace: 'id:repo-1::/tmp/orca/feature',
        destination: { selector: { kind: 'self' } }
      }),
      expect.anything()
    )
  })

  it('translates edited project and workspace fields for the runtime RPC', async () => {
    const { updateAutomationForOwner } = await client()
    callRuntimeRpc.mockResolvedValue({ automation: { id: 'a1' } })

    await updateAutomationForOwner(SELF_OWNER, 'a1', {
      projectId: 'repo-2',
      workspaceMode: 'existing',
      workspaceId: 'repo-2::/tmp/orca/other'
    })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.update',
      expect.objectContaining({
        updates: {
          repo: 'repo-2',
          workspaceMode: 'existing',
          workspace: 'id:repo-2::/tmp/orca/other'
        }
      }),
      expect.anything()
    )
  })

  it('fences a desktop mutation through IPC with the same precondition', async () => {
    const { deleteAutomationForOwner, updateAutomationForOwner } = await client()
    update.mockResolvedValue({ id: 'a1' })
    await updateAutomationForOwner({ authority: DESKTOP, selector: { kind: 'self' } }, 'a1', {
      enabled: true
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ expectedOwner: { selector: { kind: 'self' } } })
    )
    expect(getRuntimeEnvironmentStatus).not.toHaveBeenCalled()
    expect(typeof deleteAutomationForOwner).toBe('function')
  })
})

// The orphan arm used to live in the caller with its own transport choice and no
// capability probe. These pin it to the owned arm's behaviour so the two cannot
// drift apart again.
describe('orphan-fenced mutations', () => {
  it('fences on the orphan precondition over the same runtime transport', async () => {
    const { deleteOrphanAutomation } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue(ALL_CAPABILITIES)
    callRuntimeRpc.mockResolvedValue(undefined)
    await deleteOrphanAutomation(RUNTIME, 'a1')
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.delete',
      { id: 'a1', expectedOwner: { selector: { kind: 'orphan' } } },
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
  })

  it('probes the host before an orphan mutation, exactly as an owned row does', async () => {
    const { updateOrphanAutomation, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockResolvedValue({
      capabilities: [AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY]
    })
    await expect(updateOrphanAutomation(RUNTIME, 'a1', { enabled: false })).rejects.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  // An unreachable host is a retry, not an upgrade prompt — the orphan arm inherits this.
  it('propagates an unreachable authority instead of calling it incompatible', async () => {
    const { deleteOrphanAutomation, AutomationHostScopeUnsupportedError } = await client()
    getRuntimeEnvironmentStatus.mockRejectedValue(new Error('runtime_unavailable'))
    await expect(deleteOrphanAutomation(RUNTIME, 'a1')).rejects.not.toBeInstanceOf(
      AutomationHostScopeUnsupportedError
    )
  })

  it('routes a desktop orphan through IPC rather than a local RPC call', async () => {
    const { deleteOrphanAutomation, updateOrphanAutomation } = await client()
    update.mockResolvedValue({ id: 'a1' })
    await updateOrphanAutomation(DESKTOP, 'a1', { enabled: false })
    await deleteOrphanAutomation(DESKTOP, 'a1')
    expect(update).toHaveBeenCalledWith({
      id: 'a1',
      updates: { enabled: false },
      expectedOwner: { selector: { kind: 'orphan' } },
      // An orphan has no host to be moved to, so no destination is ever sent.
      destination: undefined
    })
    expect(remove).toHaveBeenCalledWith({
      id: 'a1',
      expectedOwner: { selector: { kind: 'orphan' } }
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(getRuntimeEnvironmentStatus).not.toHaveBeenCalled()
  })

  // History is the one action an orphan keeps (ORPHAN_ACTIONS), so it must reach
  // the transport rather than resolving as "no host to run on".
  it('reads an orphan run history over the runtime transport', async () => {
    const { listOrphanAutomationRuns } = await client()
    callRuntimeRpc.mockResolvedValue({ runs: [{ id: 'r1' }] })
    const runs = await listOrphanAutomationRuns(RUNTIME, 'a1')
    expect(runs).toEqual([{ id: 'r1' }])
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'automation.runs',
      { automationId: 'a1', expectedOwner: { selector: { kind: 'orphan' } } },
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
  })

  it('reads a desktop orphan history through IPC', async () => {
    const { listOrphanAutomationRuns } = await client()
    listRuns.mockResolvedValue([])
    await listOrphanAutomationRuns(DESKTOP, 'a1')
    expect(listRuns).toHaveBeenCalledWith({
      automationId: 'a1',
      expectedOwner: { selector: { kind: 'orphan' } }
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  // Read-only, so it deliberately takes the owned read's probe behaviour — which
  // today is no probe. Pinned so the two arms cannot diverge silently.
  it('probes on the orphan history read exactly as often as the owned read does', async () => {
    const { listAutomationRunsForOwner, listOrphanAutomationRuns } = await client()
    callRuntimeRpc.mockResolvedValue({ runs: [] })
    await listAutomationRunsForOwner(SSH_OWNER, 'a1')
    const ownedProbes = getRuntimeEnvironmentStatus.mock.calls.length
    getRuntimeEnvironmentStatus.mockClear()
    await listOrphanAutomationRuns(RUNTIME, 'a1')
    expect(getRuntimeEnvironmentStatus.mock.calls.length).toBe(ownedProbes)
  })

  it('cannot be handed an owner precondition — the fence is not a parameter', async () => {
    const { updateOrphanAutomation, ORPHAN_OWNER_PRECONDITION } = await client()
    update.mockResolvedValue({ id: 'a1' })
    await updateOrphanAutomation(DESKTOP, 'a1', { enabled: false })
    expect(update.mock.calls[0]?.[0]?.expectedOwner).toEqual(ORPHAN_OWNER_PRECONDITION)
    expect(updateOrphanAutomation.length).toBe(3)
  })
})

describe('matchAutomationOwnerConflict', () => {
  it('classifies a conflict rewrapped by Electron IPC', async () => {
    const { matchAutomationOwnerConflict } = await client()
    const wrapped = new Error(
      `Error invoking remote method 'automations:update': Error: This automation's host changed. Reload it before continuing.: ${AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged}`
    )
    expect(matchAutomationOwnerConflict(wrapped)).toBe(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged)
  })

  it('classifies a structured error code and ignores unrelated failures', async () => {
    const { matchAutomationOwnerConflict } = await client()
    expect(
      matchAutomationOwnerConflict({ code: AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved })
    ).toBe(AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved)
    expect(matchAutomationOwnerConflict(new Error('timeout'))).toBeNull()
  })
})

import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

export type PassiveWorktreeMetaField = 'isUnread' | 'lastActivityAt'

type MutationEntry = {
  generation: number
  fieldGeneration: Map<PassiveWorktreeMetaField, number>
  pendingFieldsByGeneration: Map<number, ReadonlySet<PassiveWorktreeMetaField>>
}

export type PassiveWorktreeMetaMutation = {
  executionHostId: ExecutionHostId
  worktreeId: string
  generation: number
}

export type PassiveWorktreeMetaRequestFence = {
  generation: number
  pendingFields: ReadonlySet<PassiveWorktreeMetaField>
}

const entriesByOwnerAndWorktree = new Map<string, MutationEntry>()
let nextGeneration = 0

function passiveFields(updates: Partial<WorktreeMeta>): Set<PassiveWorktreeMetaField> {
  const fields = new Set<PassiveWorktreeMetaField>()
  if (updates.isUnread !== undefined) {
    fields.add('isUnread')
  }
  if (updates.lastActivityAt !== undefined) {
    fields.add('lastActivityAt')
  }
  return fields
}

export function beginPassiveWorktreeMetaMutation(
  executionHostId: ExecutionHostId,
  worktreeId: string,
  updates: Partial<WorktreeMeta>
): PassiveWorktreeMetaMutation | null {
  const fields = passiveFields(updates)
  if (fields.size === 0) {
    return null
  }
  const mutationKey = getMutationKey(executionHostId, worktreeId)
  const entry = entriesByOwnerAndWorktree.get(mutationKey) ?? {
    generation: 0,
    fieldGeneration: new Map(),
    pendingFieldsByGeneration: new Map()
  }
  entry.generation = nextGeneration += 1
  for (const field of fields) {
    entry.fieldGeneration.set(field, entry.generation)
  }
  entry.pendingFieldsByGeneration.set(entry.generation, fields)
  entriesByOwnerAndWorktree.set(mutationKey, entry)
  return { executionHostId, worktreeId, generation: entry.generation }
}

export function settlePassiveWorktreeMetaMutation(
  mutation: PassiveWorktreeMetaMutation | null
): void {
  if (!mutation) {
    return
  }
  entriesByOwnerAndWorktree
    .get(getMutationKey(mutation.executionHostId, mutation.worktreeId))
    ?.pendingFieldsByGeneration.delete(mutation.generation)
}

export function capturePassiveWorktreeMetaRequestFences(
  executionHostId: ExecutionHostId,
  worktreeIds: Iterable<string>
): ReadonlyMap<string, PassiveWorktreeMetaRequestFence> {
  const fences = new Map<string, PassiveWorktreeMetaRequestFence>()
  for (const worktreeId of worktreeIds) {
    const entry = entriesByOwnerAndWorktree.get(getMutationKey(executionHostId, worktreeId))
    const pendingFields = new Set<PassiveWorktreeMetaField>()
    for (const fields of entry?.pendingFieldsByGeneration.values() ?? []) {
      for (const field of fields) {
        pendingFields.add(field)
      }
    }
    fences.set(worktreeId, { generation: entry?.generation ?? 0, pendingFields })
  }
  return fences
}

export function shouldPreservePassiveWorktreeMetaField(
  executionHostId: ExecutionHostId,
  worktreeId: string,
  field: PassiveWorktreeMetaField,
  requestFence: PassiveWorktreeMetaRequestFence | undefined
): boolean {
  const entry = entriesByOwnerAndWorktree.get(getMutationKey(executionHostId, worktreeId))
  if (!entry) {
    return false
  }
  if (requestFence?.pendingFields.has(field)) {
    return true
  }
  if ((entry.fieldGeneration.get(field) ?? 0) > (requestFence?.generation ?? 0)) {
    return true
  }
  for (const fields of entry.pendingFieldsByGeneration.values()) {
    if (fields.has(field)) {
      return true
    }
  }
  return false
}

export function forgetPassiveWorktreeMetaMutations(
  executionHostId: ExecutionHostId,
  worktreeIds: Iterable<string>
): void {
  for (const worktreeId of worktreeIds) {
    entriesByOwnerAndWorktree.delete(getMutationKey(executionHostId, worktreeId))
  }
}

function getMutationKey(executionHostId: ExecutionHostId, worktreeId: string): string {
  return `${executionHostId}\0${worktreeId}`
}

export function resetPassiveWorktreeMetaMutationsForTests(): void {
  entriesByOwnerAndWorktree.clear()
  nextGeneration = 0
}

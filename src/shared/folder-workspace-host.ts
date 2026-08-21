import {
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'

export function getFolderWorkspaceHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'> | null | undefined,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  const executionHostId =
    normalizeExecutionHostId(folderWorkspace.executionHostId) ??
    normalizeExecutionHostId(projectGroup?.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  const connectionId = folderWorkspace.connectionId ?? projectGroup?.connectionId
  return connectionId ? toSshExecutionHostId(connectionId) : defaultHostId
}

export function getFolderWorkspaceHostIdFromGroups(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId' | 'projectGroupId'>,
  projectGroups: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[],
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  const matchingGroups = projectGroups.filter(
    (group) => group.id === folderWorkspace.projectGroupId
  )
  if (matchingGroups.length <= 1) {
    return getFolderWorkspaceHostId(folderWorkspace, matchingGroups[0], defaultHostId)
  }
  const folderHostId = normalizeExecutionHostId(folderWorkspace.executionHostId)
  if (folderHostId) {
    return folderHostId
  }
  const groupExecutionHostIds = new Set(
    matchingGroups
      .map((group) => normalizeExecutionHostId(group.executionHostId))
      .filter((hostId): hostId is ExecutionHostId => hostId !== null)
  )
  if (groupExecutionHostIds.size === 1) {
    return [...groupExecutionHostIds][0]!
  }
  if (folderWorkspace.connectionId) {
    return toSshExecutionHostId(folderWorkspace.connectionId)
  }
  const groupConnectionHostIds = new Set(
    matchingGroups
      .map((group) => group.connectionId)
      .filter((connectionId): connectionId is string => Boolean(connectionId))
      .map(toSshExecutionHostId)
  )
  return groupConnectionHostIds.size === 1 ? [...groupConnectionHostIds][0]! : defaultHostId
}

import {
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'

/** Keeps folder filtering, bucketing, counting, and reveal on one host precedence. */
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

import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import { isSubmoduleWorktreeRemovalRefusal } from '../../shared/worktree/submodule-removal'
import { withSpan } from '../observability/tracer'
import { withWorktreeRemoveStageSpan } from '../observability/instrumentation'
import {
  moveWorktreeDirectoryToTrash,
  restoreWorktreeDirectoryFromTrash,
  scheduleWorktreeTrashDeletion
} from '../worktree-trash'
import { parseWslPath } from '../wsl'
import { deleteBranchAfterWorktreeRemoval } from './worktree-branch-cleanup'
import { gitExecFileAsync } from './runner'
import { gitWorktreeExecOptions } from './worktree-execution-options'
import { listWorktrees } from './worktree-listing'
import type { RemoveWorktreeOptions } from './worktree-operation-contracts'
import { areWorktreePathsEqual } from './worktree-paths'
import { clearMissingWorktreeRegistration } from './worktree-registration-repair'
import { assertWorktreeCleanForRemoval } from './worktree-removal-preflight'

export async function performRemoveWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean,
  options: RemoveWorktreeOptions
): Promise<RemoveWorktreeResult> {
  const removedWorktree =
    options.knownRemovedWorktree ??
    (await listWorktrees(repoPath, options)).find((worktree) =>
      areWorktreePathsEqual(worktree.path, worktreePath)
    )
  const branchName = (removedWorktree?.branch ?? '').replace(/^refs\/heads\//, '')
  const branchHead = removedWorktree?.head ?? ''

  assertWorktreeUnlockedForRemoval(removedWorktree)

  if (!(await tryDeferredDirectoryDeletion(repoPath, worktreePath, force, options))) {
    const args = ['worktree', 'remove']
    if (force) {
      args.push('--force')
    }
    args.push(worktreePath)
    try {
      await gitExecFileAsync(args, gitWorktreeExecOptions(repoPath, options))
    } catch (error) {
      if (force || !isSubmoduleWorktreeRemovalRefusal(error)) {
        throw error
      }
      await assertWorktreeCleanForRemoval(worktreePath, false, options)
      await gitExecFileAsync(
        ['worktree', 'remove', '--force', worktreePath],
        gitWorktreeExecOptions(repoPath, options)
      )
    }
  }

  if (!branchName || options.deleteBranch === false) {
    return {}
  }
  return withSpan('worktree.remove.branch_delete', () =>
    deleteBranchAfterWorktreeRemoval(repoPath, branchName, branchHead, options)
  )
}

async function tryDeferredDirectoryDeletion(
  repoPath: string,
  worktreePath: string,
  force: boolean,
  options: RemoveWorktreeOptions
): Promise<boolean> {
  // WSL-owned checkouts must be deleted inside the distro, never renamed by Windows Node.
  if (options.wslDistro || parseWslPath(worktreePath)) {
    return false
  }
  if (!force) {
    try {
      await assertWorktreeCleanForRemoval(worktreePath, false, options)
    } catch {
      return false
    }
  }

  const trashPath = await withWorktreeRemoveStageSpan('trash_rename', 'local', () =>
    moveWorktreeDirectoryToTrash(worktreePath)
  )
  if (!trashPath) {
    return false
  }
  try {
    await clearMissingWorktreeRegistration(repoPath, worktreePath, options)
  } catch (error) {
    if (await restoreWorktreeDirectoryFromTrash(trashPath, worktreePath)) {
      return false
    }
    throw error
  }
  scheduleWorktreeTrashDeletion(trashPath)
  return true
}

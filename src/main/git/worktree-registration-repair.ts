import type { RemoveWorktreeOptions } from './worktree-operation-contracts'
import { gitExecFileAsync } from './runner'
import { gitWorktreeExecOptions } from './worktree-execution-options'
import { listWorktreesStrict } from './worktree-listing'
import { areWorktreePathsEqual } from './worktree-paths'

export const WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS = 30_000

export async function clearMissingWorktreeRegistration(
  repoPath: string,
  worktreePath: string,
  options: RemoveWorktreeOptions
): Promise<void> {
  const registrationOptions = {
    ...options,
    timeout: options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  }
  try {
    // Removing an already-missing directory works at the Git 2.25 baseline and touches one entry.
    await gitExecFileAsync(
      ['worktree', 'remove', '--force', worktreePath],
      gitWorktreeExecOptions(repoPath, registrationOptions)
    )
    return
  } catch (error) {
    console.warn(
      `[git] Failed to deregister the moved worktree "${worktreePath}"; pruning instead`,
      error
    )
  }

  await gitExecFileAsync(
    ['worktree', 'prune'],
    gitWorktreeExecOptions(repoPath, registrationOptions)
  )
  const stillRegistered = (await listWorktreesStrict(repoPath, registrationOptions)).some(
    (worktree) => areWorktreePathsEqual(worktree.path, worktreePath)
  )
  if (stillRegistered) {
    throw new Error(`Git still reports a registration for "${worktreePath}" after pruning it.`)
  }
}

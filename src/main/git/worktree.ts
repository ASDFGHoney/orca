import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { runWithGitReadCacheInvalidation } from './git-read-cache'
import { gitExecFileAsync } from './runner'
import { clearWorktreeCreationBase, createWorktreeCheckout } from './worktree-creation'
import { gitWorktreeExecOptions } from './worktree-execution-options'
import { bumpWorktreeScanGeneration } from './worktree-listing'
import type {
  AddWorktreeOptions,
  AddWorktreeResult,
  RemoveWorktreeOptions
} from './worktree-operation-contracts'
import { performRemoveWorktree } from './worktree-removal'

export const WORKTREE_ADD_TIMEOUT_MS = 180_000
export const WORKTREE_ADD_TIMEOUT_MAX_MS = 30 * 60_000

/** Resolve the add timeout override, clamped to the supported operational range. */
export function resolveWorktreeAddTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCA_WORKTREE_ADD_TIMEOUT_MS?.trim()
  const requested = Math.floor(Number(raw))
  const resolved = Number.isNaN(requested)
    ? WORKTREE_ADD_TIMEOUT_MS
    : Math.min(Math.max(requested, WORKTREE_ADD_TIMEOUT_MS), WORKTREE_ADD_TIMEOUT_MAX_MS)
  if (raw && resolved !== requested) {
    const problem = Number.isNaN(requested)
      ? 'is not a number'
      : `is outside [${WORKTREE_ADD_TIMEOUT_MS}, ${WORKTREE_ADD_TIMEOUT_MAX_MS}]ms`
    console.warn(
      `[git/worktree] ORCA_WORKTREE_ADD_TIMEOUT_MS="${raw}" ${problem}; using ${resolved}ms`
    )
  }
  return resolved
}

/** Create a worktree and invalidate read caches and in-flight worktree scans. */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string,
  refreshLocalBaseRef = false,
  noCheckout = false,
  options: AddWorktreeOptions = {}
): Promise<AddWorktreeResult> {
  try {
    return await runWithGitReadCacheInvalidation(() =>
      createWorktreeCheckout(
        repoPath,
        worktreePath,
        branch,
        baseBranch,
        refreshLocalBaseRef,
        noCheckout,
        options,
        resolveWorktreeAddTimeoutMs
      )
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}

export async function addSparseWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  directories: string[],
  baseBranch?: string,
  refreshLocalBaseRef = false,
  options: AddWorktreeOptions = {}
): Promise<AddWorktreeResult> {
  let created = false
  let addResult: AddWorktreeResult = {}
  try {
    addResult = await addWorktree(
      repoPath,
      worktreePath,
      branch,
      baseBranch,
      refreshLocalBaseRef,
      true,
      options
    )
    created = true
    const longPathArgs = windowsLongPathGitArgs(worktreePath)
    await gitExecFileAsync(
      ['sparse-checkout', 'init', '--cone'],
      gitWorktreeExecOptions(worktreePath, options)
    )
    await gitExecFileAsync(
      [...longPathArgs, 'sparse-checkout', 'set', '--', ...directories],
      gitWorktreeExecOptions(worktreePath, options)
    )
    await gitExecFileAsync(
      [...longPathArgs, 'checkout', branch],
      gitWorktreeExecOptions(worktreePath, options)
    )
    return addResult
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error))
    const sparseError = wrapped as Error & { cleanupFailed?: boolean }
    if (created) {
      if (!options.checkoutExistingBranch) {
        await clearWorktreeCreationBase(worktreePath, branch, options)
      }
      try {
        await removeWorktree(repoPath, worktreePath, true, {
          deleteBranch: !options.checkoutExistingBranch,
          forceBranchDelete: !options.checkoutExistingBranch,
          ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
        })
      } catch {
        sparseError.cleanupFailed = true
        sparseError.message = `${sparseError.message} (cleanup also failed — the partially created worktree at "${worktreePath}" may need manual removal)`
      }
    }
    throw sparseError
  }
}

/** Move via Git so linked-worktree administrative back-pointers stay valid. */
export async function moveWorktree(
  repoPath: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(['worktree', 'move', oldPath, newPath], { cwd: repoPath })
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}

/** Remove a worktree and invalidate read caches and in-flight worktree scans. */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  try {
    return await runWithGitReadCacheInvalidation(() =>
      performRemoveWorktree(repoPath, worktreePath, force, options)
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}

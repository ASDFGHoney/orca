import {
  branchHasNoUnmergedChangesWithLazyTargetRefresh,
  getBranchCleanupTargetRefs
} from '../../shared/git-branch-cleanup'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { gitExecFileAsync } from './runner'
import type { GitWorktreeExecOptions } from './worktree-execution-options'
import { gitWorktreeExecOptions } from './worktree-execution-options'
import { parseWorktreeList } from './worktree-list-output'
import type { RemoveWorktreeOptions } from './worktree-operation-contracts'

export async function deleteBranchAfterWorktreeRemoval(
  repoPath: string,
  branchName: string,
  branchHead: string,
  options: RemoveWorktreeOptions
): Promise<RemoveWorktreeResult> {
  try {
    const result = await deleteLocalBranch(
      repoPath,
      branchName,
      options.forceBranchDelete === true,
      options
    )
    if (result === 'checked-out') {
      return {}
    }
    return {}
  } catch (error) {
    if (!options.forceBranchDelete && branchHead) {
      try {
        if (await deleteAlreadyMergedBranch(repoPath, branchName, branchHead, options)) {
          return {}
        }
      } catch (alreadyMergedDeleteError) {
        console.warn(
          `[git] Failed to delete already-merged local branch "${branchName}" after removing worktree`,
          alreadyMergedDeleteError
        )
      }
    }
    console.warn(
      `[git] Preserved local branch "${branchName}" after removing worktree (not fully merged)`,
      error
    )
    return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
  }
}

async function deleteLocalBranch(
  repoPath: string,
  branchName: string,
  forceBranchDelete: boolean,
  options: GitWorktreeExecOptions
): Promise<'deleted' | 'checked-out'> {
  const deleteFlag = forceBranchDelete ? '-D' : '-d'
  try {
    await gitExecFileAsync(
      ['branch', deleteFlag, '--', branchName],
      gitWorktreeExecOptions(repoPath, options)
    )
    return 'deleted'
  } catch (error) {
    if (!isBranchCheckedOutInWorktreeError(error)) {
      throw error
    }
  }

  try {
    await gitExecFileAsync(['worktree', 'prune'], gitWorktreeExecOptions(repoPath, options))
  } catch (error) {
    console.warn(`[git] Failed to prune worktrees before deleting branch "${branchName}"`, error)
    return 'checked-out'
  }

  try {
    await gitExecFileAsync(
      ['branch', deleteFlag, '--', branchName],
      gitWorktreeExecOptions(repoPath, options)
    )
    return 'deleted'
  } catch (error) {
    if (isBranchCheckedOutInWorktreeError(error)) {
      return 'checked-out'
    }
    throw error
  }
}

async function deleteAlreadyMergedBranch(
  repoPath: string,
  branchName: string,
  branchHead: string,
  options: GitWorktreeExecOptions
): Promise<boolean> {
  const runGit = (args: string[], execOptions?: { stdin?: string }) =>
    gitExecFileAsync(args, {
      ...gitWorktreeExecOptions(repoPath, options),
      ...(execOptions?.stdin !== undefined ? { stdin: execOptions.stdin } : {})
    })
  const targetRefs = await getBranchCleanupTargetRefs(runGit, branchName)
  const hasNoUnmergedChanges = await withLocalGitCapabilityCacheForExecution(
    { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
    (capabilities) =>
      branchHasNoUnmergedChangesWithLazyTargetRefresh(runGit, branchName, targetRefs, capabilities)
  )
  if (!hasNoUnmergedChanges) {
    return false
  }
  await forceDeleteLocalBranch(repoPath, branchName, branchHead, (args, cwd) =>
    gitExecFileAsync(args, gitWorktreeExecOptions(cwd, options))
  )
  return true
}

export async function forceDeleteLocalBranch(
  repoPath: string,
  branchName: string,
  expectedHead: string,
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }> = (
    args,
    cwd
  ) => gitExecFileAsync(args, { cwd })
): Promise<void> {
  if (!branchName || branchName.includes('\0')) {
    throw new Error('Invalid branch name')
  }
  if (!expectedHead) {
    throw new Error(
      `Cannot force-delete local branch "${branchName}" without the commit Git preserved.`
    )
  }
  if (await isLocalBranchCheckedOut(repoPath, branchName, runGit)) {
    throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
  }
  try {
    await runGit(['update-ref', '-d', `refs/heads/${branchName}`, expectedHead], repoPath)
  } catch {
    throw new Error(
      `Local branch "${branchName}" changed after the workspace was deleted. Review it before deleting it.`
    )
  }
  if (await isLocalBranchCheckedOut(repoPath, branchName, runGit)) {
    try {
      await runGit(['update-ref', `refs/heads/${branchName}`, expectedHead, ''], repoPath)
    } catch (restoreError) {
      console.warn(
        `[git] Failed to restore local branch "${branchName}" after concurrent checkout`,
        restoreError
      )
    }
    throw new Error(`Local branch "${branchName}" is checked out in another worktree.`)
  }
  try {
    await runGit(['config', '--remove-section', `branch.${branchName}`], repoPath)
  } catch {
    // Best-effort parity with `git branch -D`; stale config is harmless.
  }
}

async function isLocalBranchCheckedOut(
  repoPath: string,
  branchName: string,
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>
): Promise<boolean> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], repoPath)
  return parseWorktreeList(stdout).some(
    (worktree) => worktree.branch.replace(/^refs\/heads\//, '') === branchName
  )
}

function isBranchCheckedOutInWorktreeError(error: unknown): boolean {
  let text = String(error)
  if (typeof error === 'object' && error !== null) {
    const parts: string[] = []
    if ('message' in error && typeof error.message === 'string') {
      parts.push(error.message)
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      parts.push(error.stderr)
    }
    text = parts.join('\n')
  }
  return /cannot delete branch .*(?:used by worktree|checked out)|branch .*is checked out/i.test(
    text
  )
}

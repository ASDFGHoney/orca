import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { hasWorktreeBaseCommitRef } from './worktree-base-ref-probe'
import { getLocalBaseRefUpdateSuggestion, refreshLocalBaseRef } from './worktree-base-ref-refresh'
import { gitExecFileAsync } from './runner'
import { gitWorktreeExecOptions } from './worktree-execution-options'
import type { AddWorktreeOptions, AddWorktreeResult } from './worktree-operation-contracts'

export async function createWorktreeCheckout(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string | undefined,
  refreshBaseRef: boolean,
  noCheckout: boolean,
  options: AddWorktreeOptions,
  resolveTimeout: () => number
): Promise<AddWorktreeResult> {
  let localBaseRefRefresh: LocalBaseRefRefreshResult | undefined
  let localBaseRefUpdateSuggestion: LocalBaseRefUpdateSuggestion | undefined
  const args = [...windowsLongPathGitArgs(repoPath), 'worktree', 'add']
  let effectiveBase: string | undefined
  if (noCheckout) {
    args.push('--no-checkout')
  }
  if (options.checkoutExistingBranch) {
    args.push(worktreePath, branch)
  } else {
    args.push('--no-track', '-b', branch, worktreePath)
    if (baseBranch) {
      effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, (qualifiedRef) =>
        hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
      )
      if (refreshBaseRef) {
        localBaseRefRefresh = await refreshLocalBaseRef(
          repoPath,
          baseBranch,
          effectiveBase,
          options.remoteTrackingBase,
          options
        )
      } else if (options.suggestLocalBaseRefUpdate) {
        localBaseRefUpdateSuggestion = await getLocalBaseRefUpdateSuggestion(
          repoPath,
          baseBranch,
          effectiveBase,
          options.remoteTrackingBase,
          options
        )
      }
      args.push(effectiveBase)
    }
  }
  await gitExecFileAsync(args, {
    ...gitWorktreeExecOptions(repoPath, options),
    timeout: resolveTimeout()
  })

  if (options.checkoutExistingBranch) {
    return localBaseRefRefresh ? { localBaseRefRefresh } : {}
  }
  if (effectiveBase) {
    await persistWorktreeCreationBase(worktreePath, branch, effectiveBase, options)
  }
  await configureAutomaticUpstreamSetup(worktreePath, options)
  return {
    ...(localBaseRefRefresh ? { localBaseRefRefresh } : {}),
    ...(localBaseRefUpdateSuggestion ? { localBaseRefUpdateSuggestion } : {})
  }
}

export async function clearWorktreeCreationBase(
  worktreePath: string,
  branch: string,
  options: AddWorktreeOptions
): Promise<void> {
  try {
    await gitExecFileAsync(
      ['config', '--local', '--unset-all', `branch.${branch}.base`],
      gitWorktreeExecOptions(worktreePath, options)
    )
  } catch {
    // Best-effort cleanup leaves the original sparse setup error actionable.
  }
}

async function persistWorktreeCreationBase(
  worktreePath: string,
  branch: string,
  effectiveBase: string,
  options: AddWorktreeOptions
): Promise<void> {
  const configKey = `branch.${branch}.base`
  try {
    await gitExecFileAsync(
      ['config', '--local', '--replace-all', configKey, effectiveBase],
      gitWorktreeExecOptions(worktreePath, options)
    )
  } catch (error) {
    console.warn(`addWorktree: failed to set ${configKey} for ${worktreePath}`, error)
    try {
      await gitExecFileAsync(
        ['config', '--local', '--unset-all', configKey],
        gitWorktreeExecOptions(worktreePath, options)
      )
    } catch (unsetError) {
      console.warn(
        `addWorktree: failed to unset stale ${configKey} for ${worktreePath}`,
        unsetError
      )
    }
  }
}

async function configureAutomaticUpstreamSetup(
  worktreePath: string,
  options: AddWorktreeOptions
): Promise<void> {
  try {
    let alreadySet = false
    try {
      await gitExecFileAsync(
        ['config', '--get', 'push.autoSetupRemote'],
        gitWorktreeExecOptions(worktreePath, options)
      )
      alreadySet = true
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 1)) {
        throw error
      }
    }
    if (!alreadySet) {
      await gitExecFileAsync(
        ['config', '--local', 'push.autoSetupRemote', 'true'],
        gitWorktreeExecOptions(worktreePath, options)
      )
    }
  } catch (error) {
    console.warn(`addWorktree: failed to set push.autoSetupRemote for ${worktreePath}`, error)
  }
}

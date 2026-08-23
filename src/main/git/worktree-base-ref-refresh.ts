import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import { parseGitRevListAheadBehindCounts } from '../../shared/git-rev-list-output'
import { probeWorktreeBaseRefPresence } from './worktree-base-ref-probe'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'
import type { GitWorktreeExecOptions } from './worktree-execution-options'
import { gitWorktreeExecOptions } from './worktree-execution-options'
import type { AddWorktreeOptions } from './worktree-operation-contracts'
import { parseWorktreeList } from './worktree-list-output'

type Refreshability =
  | {
      refreshable: true
      baseRef: string
      localBranch: string
      fullRef: string
      remoteTrackingRef: string
      localOid: string
      remoteOid: string
      behind: number
      ownerWorktreePath?: string
    }
  | { refreshable: false; result: LocalBaseRefRefreshResult }

export async function getLocalBaseRefUpdateSuggestion(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const evaluation = await evaluateRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase,
    options,
    (behind) => behind > 0
  )
  if (!evaluation?.refreshable || evaluation.behind <= 0) {
    return undefined
  }
  return {
    baseRef: evaluation.baseRef,
    localBranch: evaluation.localBranch,
    behind: evaluation.behind
  }
}

export async function refreshLocalBaseRef(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefRefreshResult | undefined> {
  const evaluation = await evaluateRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase,
    options
  )
  if (!evaluation) {
    return undefined
  }
  if (!evaluation.refreshable) {
    return evaluation.result
  }

  const resultBase = { baseRef: evaluation.baseRef, localBranch: evaluation.localBranch }
  try {
    if (evaluation.ownerWorktreePath) {
      const { stdout } = await gitExecFileAsync(
        ['worktree', 'list', '--porcelain'],
        gitWorktreeExecOptions(repoPath, options)
      )
      const owner = parseWorktreeList(translateWslOutputPaths(stdout, repoPath, options)).find(
        (worktree) => worktree.branch === evaluation.fullRef
      )
      if (!owner || owner.path !== evaluation.ownerWorktreePath) {
        return { ...resultBase, status: 'skipped_error' }
      }
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        gitWorktreeExecOptions(owner.path, options)
      )
      if (status.trim()) {
        return {
          ...resultBase,
          status: 'skipped_dirty_worktree',
          ownerWorktreePath: owner.path
        }
      }
      await gitExecFileAsync(
        ['reset', '--hard', evaluation.remoteOid],
        gitWorktreeExecOptions(owner.path, options)
      )
      return { ...resultBase, status: 'updated', ownerWorktreePath: owner.path }
    }
    await gitExecFileAsync(
      ['update-ref', evaluation.fullRef, evaluation.remoteOid, evaluation.localOid],
      gitWorktreeExecOptions(repoPath, options)
    )
    return { ...resultBase, status: 'updated' }
  } catch {
    return { ...resultBase, status: 'skipped_error' }
  }
}

async function evaluateRefreshability(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions,
  shouldInspectOwner: (behind: number) => boolean = () => true
): Promise<Refreshability | undefined> {
  const parsed = parseRemoteTrackingLocalBaseRef(baseBranch, remoteTrackingRef, remoteTrackingBase)
  if (!parsed) {
    return undefined
  }
  const resultBase = { baseRef: parsed.baseRef, localBranch: parsed.localBranch }

  let drift: { ahead: number; behind: number }
  let localOid = ''
  let remoteOid = ''
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--left-right', '--count', `${parsed.fullRef}...${remoteTrackingRef}`],
      gitWorktreeExecOptions(repoPath, options)
    )
    const counts = parseGitRevListAheadBehindCounts(stdout)
    if (counts.status !== 'ok' || counts.ahead !== 0) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    if (!shouldInspectOwner(counts.behind)) {
      return undefined
    }
    const local = await gitExecFileAsync(
      ['rev-parse', '--verify', `${parsed.fullRef}^{commit}`],
      gitWorktreeExecOptions(repoPath, options)
    )
    localOid = local.stdout.trim()
    if (!localOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    const remote = await gitExecFileAsync(
      ['rev-parse', '--verify', `${remoteTrackingRef}^{commit}`],
      gitWorktreeExecOptions(repoPath, options)
    )
    remoteOid = remote.stdout.trim()
    if (!remoteOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    await gitExecFileAsync(
      ['merge-base', '--is-ancestor', localOid, remoteOid],
      gitWorktreeExecOptions(repoPath, options)
    )
    drift = { ahead: counts.ahead, behind: counts.behind }
  } catch {
    const presence = await probeWorktreeBaseRefPresence(
      (args) => gitExecFileAsync(args, gitWorktreeExecOptions(repoPath, options)),
      parsed.fullRef
    )
    if (presence === 'absent') {
      return undefined
    }
    return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
  }

  try {
    const { stdout } = await gitExecFileAsync(
      ['worktree', 'list', '--porcelain'],
      gitWorktreeExecOptions(repoPath, options)
    )
    const owner = parseWorktreeList(translateWslOutputPaths(stdout, repoPath, options)).find(
      (worktree) => worktree.branch === parsed.fullRef
    )
    if (owner) {
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        gitWorktreeExecOptions(owner.path, options)
      )
      if (status.trim()) {
        return {
          refreshable: false,
          result: {
            ...resultBase,
            status: 'skipped_dirty_worktree',
            ownerWorktreePath: owner.path
          }
        }
      }
      return {
        refreshable: true,
        ...resultBase,
        fullRef: parsed.fullRef,
        remoteTrackingRef,
        localOid,
        remoteOid,
        behind: drift.behind,
        ownerWorktreePath: owner.path
      }
    }
    return {
      refreshable: true,
      ...resultBase,
      fullRef: parsed.fullRef,
      remoteTrackingRef,
      localOid,
      remoteOid,
      behind: drift.behind
    }
  } catch {
    return { refreshable: false, result: { ...resultBase, status: 'skipped_error' } }
  }
}

function parseRemoteTrackingLocalBaseRef(
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase']
): { baseRef: string; localBranch: string; fullRef: string } | undefined {
  if (remoteTrackingBase?.ref === remoteTrackingRef) {
    return {
      baseRef: remoteTrackingBase.base,
      localBranch: remoteTrackingBase.branch,
      fullRef: `refs/heads/${remoteTrackingBase.branch}`
    }
  }
  const prefix = 'refs/remotes/'
  if (!remoteTrackingRef.startsWith(prefix)) {
    return undefined
  }
  const shortRef = remoteTrackingRef.slice(prefix.length)
  const slashIndex = shortRef.indexOf('/')
  if (slashIndex <= 0) {
    return undefined
  }
  const localBranch = shortRef.slice(slashIndex + 1)
  return { baseRef: baseBranch, localBranch, fullRef: `refs/heads/${localBranch}` }
}

import { gitExecFileAsync } from './runner'
import { resolveLocalBranchName } from './base-ref-search'
import { repositoryGitExecOptions, type LocalGitExecOptions } from './repository-git-execution'

export type BranchConflictKind = 'local' | 'remote'

async function hasGitRef(
  path: string,
  ref: string,
  options: LocalGitExecOptions
): Promise<boolean> {
  try {
    await gitExecFileAsync(['rev-parse', '--verify', ref], repositoryGitExecOptions(path, options))
    return true
  } catch {
    return false
  }
}

async function listRemoteNames(path: string, options: LocalGitExecOptions): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(['remote'], repositoryGitExecOptions(path, options))
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function getBranchConflictKind(
  path: string,
  branchName: string,
  allowedBaseRef?: string,
  options: LocalGitExecOptions = {}
): Promise<BranchConflictKind | null> {
  if (await hasGitRef(path, `refs/heads/${branchName}`, options)) {
    return 'local'
  }

  try {
    const remoteNames = (await listRemoteNames(path, options)).sort(
      (left, right) => right.length - left.length
    )
    const { stdout } = await gitExecFileAsync(
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      repositoryGitExecOptions(path, options)
    )
    const normalizedAllowedRef = allowedBaseRef
      ? allowedBaseRef.startsWith('refs/remotes/')
        ? allowedBaseRef
        : `refs/remotes/${allowedBaseRef}`
      : null
    const hasRemoteConflict = stdout.split('\n').some((ref) => {
      const trimmed = ref.trim()
      if (normalizedAllowedRef && trimmed === normalizedAllowedRef) {
        return false
      }
      const shortRef = trimmed.replace(/^refs\/remotes\//, '')
      // Git allows slashes in remote names; use the configured list to find the branch boundary.
      return resolveLocalBranchName(trimmed, shortRef, remoteNames) === branchName
    })

    return hasRemoteConflict ? 'remote' : null
  } catch {
    return null
  }
}

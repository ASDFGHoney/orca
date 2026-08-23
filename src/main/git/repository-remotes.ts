import { buildHostedRemoteCommitUrl, buildHostedRemoteFileUrl } from './hosted-remote-url'
import { getDefaultBaseRef, getBaseRefDefault } from './default-base-ref'
import { gitExecFileAsync } from './runner'
import { gitExecFileSync } from './git-process-launch'
import { repositoryGitExecOptions, type LocalGitExecOptions } from './repository-git-execution'

/** Get the remote origin URL, or null if not set. */
export function getRemoteUrl(path: string): string | null {
  try {
    return gitExecFileSync(['remote', 'get-url', 'origin'], { cwd: path }).trim()
  } catch {
    return null
  }
}

/** Parse `git remote` stdout into a remote count. Shared local/SSH so count semantics can't drift. */
export function parseRemoteCount(stdout: string): number {
  return stdout.split('\n').filter((line) => line.trim().length > 0).length
}

/** Count configured remotes; returns 0 on error so callers read it as unknown/no hint. */
export async function getRemoteCount(path: string): Promise<number> {
  try {
    const { stdout } = await gitExecFileAsync(['remote'], { cwd: path })
    return parseRemoteCount(stdout)
  } catch (err) {
    console.warn('[getRemoteCount] git remote failed', { path, err })
    return 0
  }
}

/**
 * Resolve the default push remote: configured default branch remote, origin, or the sole remote.
 */
export async function getDefaultRemote(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string> {
  const defaultRef = await getBaseRefDefault(path, options)
  const defaultBranch = defaultRef
    ? defaultRef.includes('/')
      ? defaultRef.split('/').slice(1).join('/')
      : defaultRef
    : null

  if (defaultBranch) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['config', '--get', `branch.${defaultBranch}.remote`],
        repositoryGitExecOptions(path, options)
      )
      const value = stdout.trim()
      if (value) {
        return value
      }
    } catch {
      // Fall through: branch has no explicit remote configured.
    }
  }

  try {
    const { stdout } = await gitExecFileAsync(['remote'], repositoryGitExecOptions(path, options))
    const remotes = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (remotes.includes('origin')) {
      return 'origin'
    }
    if (remotes.length === 1) {
      return remotes[0]
    }
    if (remotes.length === 0) {
      throw new Error('Repo has no configured git remotes.')
    }
    throw new Error(
      `Repo has multiple remotes (${remotes.join(', ')}) and no default is configured. Set branch.<default>.remote.`
    )
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error('Failed to resolve default remote for repo.')
  }
}

/** Build a hosted URL for a file and line; null when origin is unsupported or no base ref exists. */
export function getRemoteFileUrl(
  repoPath: string,
  relativePath: string,
  line: number
): string | null {
  const remoteUrl = getRemoteUrl(repoPath)
  if (!remoteUrl) {
    return null
  }
  const defaultBaseRef = getDefaultBaseRef(repoPath)
  if (!defaultBaseRef) {
    return null
  }
  return buildHostedRemoteFileUrl(
    remoteUrl,
    relativePath,
    defaultBaseRef.replace(/^origin\//, ''),
    line
  )
}

/** Build a hosted URL for a commit; null when origin isn't a recognized host. */
export function getRemoteCommitUrl(repoPath: string, sha: string): string | null {
  const remoteUrl = getRemoteUrl(repoPath)
  if (!remoteUrl) {
    return null
  }
  return buildHostedRemoteCommitUrl(remoteUrl, sha)
}

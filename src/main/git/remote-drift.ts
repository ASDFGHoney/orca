import { parseGitRevListAheadBehindCounts } from '../../shared/git-rev-list-output'
import { gitExecFileAsync } from './runner'
import { repositoryGitExecOptions, type LocalGitExecOptions } from './repository-git-execution'

const REMOTE_DRIFT_PROBE_TIMEOUT_MS = 15_000

/** Return the merge-base-symmetric delta for localRef vs remoteRef, or null on failure. */
export async function getRemoteDrift(
  repoPath: string,
  localRef: string,
  remoteRef: string,
  options: LocalGitExecOptions = {}
): Promise<{ ahead: number; behind: number } | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`],
      {
        ...repositoryGitExecOptions(repoPath, options),
        timeout: REMOTE_DRIFT_PROBE_TIMEOUT_MS
      }
    )
    const counts = parseGitRevListAheadBehindCounts(stdout)
    if (counts.status !== 'ok') {
      return null
    }
    return { ahead: counts.ahead, behind: counts.behind }
  } catch {
    return null
  }
}

/** Up to `limit` commit subjects on remoteRef but not localRef, recency order; [] on git failure. */
export async function getRecentDriftSubjects(
  repoPath: string,
  localRef: string,
  remoteRef: string,
  limit: number,
  options: LocalGitExecOptions = {}
): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['log', '--format=%s', '-n', String(limit), `${localRef}..${remoteRef}`],
      {
        ...repositoryGitExecOptions(repoPath, options),
        timeout: REMOTE_DRIFT_PROBE_TIMEOUT_MS
      }
    )
    return stdout.split('\n').filter((subject) => subject.trim().length > 0)
  } catch {
    return []
  }
}

import { randomUUID } from 'node:crypto'
import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import {
  REBASE_SOURCE_FETCH_TIMEOUT_MS,
  resolveGitRemoteRebaseSource
} from '../../shared/git-rebase-source'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'

export async function gitPullRebaseFromBase(
  worktreePath: string,
  baseRef: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(async () => {
    let rebaseRef: string | null = null
    try {
      const source = await resolveGitRemoteRebaseSource(
        (args) => gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options)),
        baseRef
      )
      let forkPoint: string | null = null
      try {
        const { stdout } = await gitExecFileAsync(
          ['merge-base', '--fork-point', `refs/remotes/${source.displayName}`, 'HEAD'],
          gitOptionsForWorktree(worktreePath, options)
        )
        forkPoint = stdout.trim() || null
      } catch {
        // A first fetch or an unhelpful reflog falls back to Git's merge-base behavior.
      }
      // Why: concurrent fetches can replace FETCH_HEAD and remote-tracking refs between fetch and rebase.
      rebaseRef = `refs/orca/rebase/${randomUUID()}`
      await gitExecFileAsync(
        ['fetch', source.remoteName, `+refs/heads/${source.branchName}:${rebaseRef}`],
        { ...gitOptionsForWorktree(worktreePath, options), timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS }
      )
      await gitExecFileAsync(
        forkPoint ? ['rebase', '--onto', rebaseRef, forkPoint] : ['rebase', rebaseRef],
        gitOptionsForWorktree(worktreePath, options)
      )
    } catch (error) {
      throw new Error(normalizeGitErrorMessage(error, 'pull'))
    } finally {
      if (rebaseRef) {
        try {
          await gitExecFileAsync(
            ['update-ref', '-d', rebaseRef],
            gitOptionsForWorktree(worktreePath, options)
          )
        } catch {
          // Cleanup must not hide the fetch or rebase result.
        }
      }
    }
  })
}

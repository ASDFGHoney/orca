import { gitExecFileAsync } from './runner'
import { gitWorktreeExecOptions } from './worktree-execution-options'
import type { WorktreeRemovalPreflightOptions } from './worktree-operation-contracts'

export const WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS = 30_000

export async function assertWorktreeCleanForRemoval(
  worktreePath: string,
  force = false,
  options: WorktreeRemovalPreflightOptions = {}
): Promise<void> {
  if (force) {
    return
  }

  const { ignoredUntrackedPaths = [], ...gitOptions } = options
  const useNullTerminatedStatus = ignoredUntrackedPaths.length > 0
  const { stdout } = await gitExecFileAsync(
    ['status', '--porcelain', ...(useNullTerminatedStatus ? ['-z'] : []), '--untracked-files=all'],
    {
      ...gitWorktreeExecOptions(worktreePath, gitOptions),
      timeout: gitOptions.timeout ?? WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS
    }
  )
  const blockingEntries = useNullTerminatedStatus
    ? getBlockingUntrackedStatusEntries(stdout, ignoredUntrackedPaths)
    : null
  if (blockingEntries ? blockingEntries.length === 0 : !stdout.trim()) {
    return
  }

  const error = new Error('Worktree has uncommitted or untracked changes.')
  ;(error as Error & { stdout?: string }).stdout = blockingEntries
    ? blockingEntries.join('\n')
    : stdout
  throw error
}

function getBlockingUntrackedStatusEntries(
  status: string,
  ignoredUntrackedPaths: readonly string[]
): string[] {
  const ignored = new Set(
    ignoredUntrackedPaths
      .map((entry) =>
        entry
          .trim()
          .replace(/^[\\/]+/, '')
          .replace(/\\/g, '/')
      )
      .filter((entry) => entry && !entry.split('/').includes('..'))
  )
  return status
    .split('\0')
    .filter(Boolean)
    .filter(
      (entry) => !(entry.startsWith('?? ') && ignored.has(entry.slice(3).replace(/\\/g, '/')))
    )
}

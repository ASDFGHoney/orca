import type { GitStatusEntry } from '../../shared/git-status-types'
import {
  applyLineStats,
  collectUntrackedAdditions,
  parseNumstat,
  type GitLineStats
} from '../../shared/git-uncommitted-line-stats'
import {
  computeGitBranchLineTotal,
  readGitBranchLineTotalMergeBaseParam,
  GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS,
  type GitBranchLineTotal
} from '../../shared/git-branch-line-total'
import { gitExecFileAsync } from './runner'
import { gitOptionalLocksDisabledEnv } from './git-environment-policy'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitStatusReadOptionsForWorktree } from './git-runtime-options'
import type { GetStatusOptions } from './status-query-options'

/** Undefined — and therefore zero extra work — unless the caller asked for a total we can know exact. */
export function createBranchLineTotalInput(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GetStatusOptions,
  statusSucceeded: boolean
): { mergeBase: string; compute: () => Promise<GitBranchLineTotal | undefined> } | undefined {
  const mergeBase = readGitBranchLineTotalMergeBaseParam(options.branchLineTotalMergeBase)
  // Why: a failed status scan leaves the untracked list untrustworthy, so the
  // total would silently under-count rather than be absent.
  if (mergeBase === undefined || !statusSucceeded) {
    return undefined
  }
  return {
    mergeBase,
    compute: () =>
      computeGitBranchLineTotal({
        worktreePath,
        // Why: the same path can be a different filesystem per WSL distro.
        hostKey: options.wslDistro ?? 'native',
        mergeBase,
        untrackedPaths: entries
          .filter((entry) => entry.area === 'untracked')
          .map((entry) => entry.path),
        runDiffNumstat: (args, signal) =>
          gitExecFileAsync(args, {
            ...gitStatusReadOptionsForWorktree(worktreePath, options),
            // Why: after the spread, so the shared lease signal wins over this caller's own.
            signal,
            env: gitOptionalLocksDisabledEnv(),
            timeout: GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS
          }).then((result) => result.stdout),
        ...(options.signal ? { signal: options.signal } : {})
      })
  }
}

export function getStatusLineStatsCacheKey(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): string {
  // Why: identical paths can map to different WSL-distro filesystems, so key stats by Git's execution host.
  return `${options.wslDistro ?? 'native'}\0${worktreePath}`
}

async function runNumstat(
  worktreePath: string,
  cached: boolean,
  options: GitRuntimeOptions = {}
): Promise<Map<string, GitLineStats> | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '-z',
        ...(cached ? ['--cached'] : []),
        '--numstat',
        '-M'
      ],
      {
        ...gitStatusReadOptionsForWorktree(worktreePath, options),
        env: gitOptionalLocksDisabledEnv()
      }
    )
    return parseNumstat(stdout)
  } catch (error) {
    // Why: an aborted pass must reject; only a genuine numstat failure degrades to uncounted rows.
    if (options.signal?.aborted) {
      throw error
    }
    // Why: a numstat failure leaves rows uncounted; null (not empty map) flags the pass incomplete and uncacheable.
    return null
  }
}

/** Returns false when a numstat pass failed, so callers skip caching it. */
export async function attachLineStats(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GitRuntimeOptions = {}
): Promise<boolean> {
  if (entries.length === 0) {
    return true
  }
  const hasStaged = entries.some((entry) => entry.area === 'staged')
  const hasUnstaged = entries.some((entry) => entry.area === 'unstaged')
  const untrackedPaths = entries
    .filter((entry) => entry.area === 'untracked')
    .map((entry) => entry.path)
  const emptyStats = new Map<string, GitLineStats>()
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all([
    hasStaged ? runNumstat(worktreePath, true, options) : Promise.resolve(emptyStats),
    hasUnstaged ? runNumstat(worktreePath, false, options) : Promise.resolve(emptyStats),
    collectUntrackedAdditions(worktreePath, untrackedPaths, options.signal)
  ])
  for (const entry of entries) {
    applyLineStats(
      entry,
      entry.area === 'staged'
        ? (stagedStats ?? emptyStats).get(entry.path)
        : entry.area === 'unstaged'
          ? (unstagedStats ?? emptyStats).get(entry.path)
          : untrackedStats.get(entry.path)
    )
  }
  return stagedStats !== null && unstagedStats !== null
}

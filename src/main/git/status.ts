import type {
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus
} from '../../shared/git-status-types'
import { StatusPorcelainParser } from '../../shared/git-status-porcelain-parser'
import { resolveGitStatusLimit } from '../../shared/git-status-limit'
import { stableInFlightKey } from '../../shared/in-flight-promise-dedupe'
import {
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCacheKey,
  reuseOrRecomputeGitStatusLineStats
} from '../../shared/git-status-line-stats-cache'
import type { GitBranchLineTotal } from '../../shared/git-branch-line-total'
import { findExistingWorktreeSymlinkPaths } from './worktree-symlink-detection'
import { gitOptionalLocksDisabledEnv } from './git-environment-policy'
import { gitStreamStdout } from './git-stream'
import type { GetStatusOptions } from './status-query-options'
import { leaseGitStatusRead } from './git-read-cache'
import { clearGitDiffReadCache } from './git-diff-read-cache'
import { detectConflictOperation, parseUnmergedEntry } from './conflict-status'
import {
  getEffectiveUpstreamStatusCacheKey,
  getShortBranchName,
  readOrProbeEffectiveUpstreamStatus,
  shouldProbeEffectiveUpstreamStatus
} from './effective-upstream-status-cache'
import {
  attachLineStats,
  createBranchLineTotalInput,
  getStatusLineStatsCacheKey
} from './status-line-stats'

/** Parse `git status --porcelain=v2` output into structured entries. */
export async function getStatus(
  worktreePath: string,
  options: GetStatusOptions = {}
): Promise<GitStatusResult> {
  clearGitDiffReadCache()
  // Why: dedupe only concurrent identical reads; after settle, callers must run a fresh read.
  const cacheKey = getStatusReadKey(worktreePath, options)
  return leaseGitStatusRead(cacheKey, options.signal, (sharedSignal) =>
    runGetStatus(worktreePath, { ...options, signal: sharedSignal })
  )
}

function getStatusReadKey(worktreePath: string, options: GetStatusOptions): string {
  // Why: each key part can change the output shape or runtime routing.
  const limit = resolveGitStatusLimit(options.limit)
  return stableInFlightKey([
    worktreePath,
    options.wslDistro ?? '',
    options.includeIgnored === true,
    options.reuseLineStats === true,
    options.branchLineTotalMergeBase ?? '',
    options.bypassEffectiveUpstreamNegativeCache === true,
    limit,
    // Why: this changes which entries survive, so it must not share a cache slot.
    options.sharedLinkPaths ?? []
  ])
}

async function dropSharedSymlinkUntrackedEntries(
  worktreePath: string,
  entries: GitStatusEntry[],
  sharedLinkPaths: readonly string[]
): Promise<void> {
  // Why: a clean tree has no untracked entries, so this costs nothing on the common poll path.
  if (sharedLinkPaths.length === 0 || !entries.some((entry) => entry.area === 'untracked')) {
    return
  }
  const sharedLinks = new Set(await findExistingWorktreeSymlinkPaths(worktreePath, sharedLinkPaths))
  if (sharedLinks.size === 0) {
    return
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.area === 'untracked' && sharedLinks.has(entry.path)) {
      entries.splice(index, 1)
    }
  }
}

async function runGetStatus(
  worktreePath: string,
  options: GetStatusOptions = {}
): Promise<GitStatusResult> {
  const lineStatsCacheKey = getStatusLineStatsCacheKey(worktreePath, options)
  const lineStatsWriteToken = beginGitStatusLineStatsCacheWrite(lineStatsCacheKey)
  let effectiveUpstreamStatus: GitUpstreamStatus | undefined
  let statusSucceeded = false
  const limit = resolveGitStatusLimit(options.limit)

  // Why: conflict detection and status are independent, so run concurrently.
  const conflictPromise = detectConflictOperation(worktreePath)
  const statusArgs = [
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all'
  ]
  if (options.includeIgnored) {
    statusArgs.push('--ignored=matching')
  }

  const parser = new StatusPorcelainParser()
  let didHitLimit = false
  // Why: attach rejection ownership before awaiting marker I/O so a fast Git failure is handled.
  const statusSettlementPromise = Promise.allSettled([
    (async () => {
      const result = await gitStreamStdout(statusArgs, {
        cwd: worktreePath,
        wslDistro: options.wslDistro,
        preferWslDirectGit: true,
        env: gitOptionalLocksDisabledEnv(),
        signal: options.signal,
        onStdout: (chunk) => parser.update(chunk, limit)
      })
      if (!result.stoppedEarly) {
        parser.finish()
      }
      return result
    })()
  ])
  const conflictOperation = await conflictPromise

  try {
    const [statusResult] = await statusSettlementPromise
    if (statusResult.status === 'rejected') {
      throw statusResult.reason
    }
    didHitLimit = statusResult.value.stoppedEarly
    statusSucceeded = true
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    // Not a Git repository or Git is unavailable.
  }

  const entries: GitStatusEntry[] = []
  const { head, branch, upstreamName, upstreamAheadBehind } = parser.branch
  // Why: resolve deferred conflicts in Git output order so the cap preserves ordering.
  for (const record of parser.statusRecords) {
    if (didHitLimit && entries.length >= limit) {
      break
    }
    if (record.type === 'entry') {
      entries.push(record.entry)
    } else {
      const unmergedEntry = await parseUnmergedEntry(worktreePath, record.line)
      if (unmergedEntry) {
        entries.push(unmergedEntry)
      }
    }
  }

  await dropSharedSymlinkUntrackedEntries(worktreePath, entries, options.sharedLinkPaths ?? [])

  if (statusSucceeded && !didHitLimit && shouldProbeEffectiveUpstreamStatus(branch, upstreamName)) {
    const branchName = getShortBranchName(branch)
    if (branchName) {
      const cacheKey = getEffectiveUpstreamStatusCacheKey(
        worktreePath,
        branchName,
        upstreamName,
        options
      )
      try {
        // Why: shared probes are unbound from one request signal; one abort must not reject others.
        const { signal: _requestSignal, ...sharedProbeOptions } = options
        effectiveUpstreamStatus = await readOrProbeEffectiveUpstreamStatus(
          cacheKey,
          worktreePath,
          branchName,
          sharedProbeOptions,
          options.bypassEffectiveUpstreamNegativeCache === true
        )
      } catch {
        // Status polling degrades on transient upstream-probe errors.
      }
    }
  }
  let branchLineTotal: GitBranchLineTotal | undefined
  if (!didHitLimit) {
    const branchLineTotalInput = createBranchLineTotalInput(
      worktreePath,
      entries,
      options,
      statusSucceeded
    )
    const lineStats = await reuseOrRecomputeGitStatusLineStats({
      cacheKey: lineStatsCacheKey,
      head,
      entries,
      writeToken: lineStatsWriteToken,
      reuse: options.reuseLineStats === true,
      isAborted: () => options.signal?.aborted === true,
      recompute: () => attachLineStats(worktreePath, entries, options),
      ...(branchLineTotalInput ? { branchLineTotal: branchLineTotalInput } : {})
    })
    branchLineTotal = lineStats.branchLineTotal
  } else {
    clearGitStatusLineStatsCacheKey(lineStatsCacheKey, lineStatsWriteToken)
  }

  if (options.signal?.aborted) {
    const error = new Error('The operation was aborted.')
    error.name = 'AbortError'
    throw error
  }

  return {
    entries,
    conflictOperation,
    head,
    branch,
    ...(options.includeIgnored ? { ignoredPaths: parser.ignoredPaths } : {}),
    ...(branchLineTotal ? { branchLineTotal } : {}),
    ...(didHitLimit ? { didHitLimit: true, statusLength: parser.statusLength } : {}),
    ...(statusSucceeded
      ? {
          upstreamStatus:
            effectiveUpstreamStatus ??
            (upstreamName
              ? {
                  hasUpstream: true,
                  upstreamName,
                  ahead: upstreamAheadBehind?.ahead ?? 0,
                  behind: upstreamAheadBehind?.behind ?? 0
                }
              : { hasUpstream: false, ahead: 0, behind: 0 })
        }
      : {})
  }
}

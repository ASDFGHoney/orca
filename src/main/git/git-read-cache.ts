import type { GitStatusResult } from '../../shared/git-status-types'
import { clearGitStatusLineStatsCache } from '../../shared/git-status-line-stats-cache'
import { invalidateGitBranchLineTotalInFlight } from '../../shared/git-branch-line-total'
import { GitStatusReadLeaseOwner } from './git-status-read-lease-owner'
import { invalidateGitUpstreamStatusReads } from './upstream'
import { clearGitDiffReadCache } from './git-diff-read-cache'
import { clearSubmodulePathsCacheForTests } from './submodule-paths'
import {
  clearEffectiveUpstreamStatusCaches,
  clearResolvedUpstreamNameCache
} from './effective-upstream-status-cache'

const statusReadLeaseOwner = new GitStatusReadLeaseOwner<GitStatusResult>()

export function leaseGitStatusRead(
  cacheKey: string,
  signal: AbortSignal | undefined,
  read: (signal: AbortSignal) => Promise<GitStatusResult>
): Promise<GitStatusResult> {
  return statusReadLeaseOwner.lease(cacheKey, signal, read)
}

// Why: clearing only some in-flight reads would let a post-mutation status join
// a pre-mutation read and publish it as current.
export function invalidateGitReadCaches(): void {
  clearGitDiffReadCache()
  statusReadLeaseOwner.invalidate()
  invalidateGitBranchLineTotalInFlight()
  invalidateGitUpstreamStatusReads()
  clearGitStatusLineStatsCache()
  clearSubmodulePathsCacheForTests()
  clearResolvedUpstreamNameCache()
}
export function clearEffectiveUpstreamStatusCacheForTests(): void {
  clearEffectiveUpstreamStatusCaches()
  invalidateGitReadCaches()
}

export async function runWithGitReadCacheInvalidation<T>(run: () => Promise<T>): Promise<T> {
  invalidateGitReadCaches()
  try {
    return await run()
  } finally {
    // Why: a read that started mid-mutation can be stale too, so invalidate again after.
    invalidateGitReadCaches()
  }
}

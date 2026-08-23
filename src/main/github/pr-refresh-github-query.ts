import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import { getPRForBranchOutcome, type GitHubPRBranchLookupOptions } from './client'
import { getOriginGitHubApiRepository } from './github-api-repository'
import { ghRepoExecOptions, githubRepoContext } from './gh-utils'
import { getRateLimit, repositoryRateLimitGuard, spendsSharedGitHubComQuota } from './rate-limit'

const REFRESH_RATE_LIMIT_BUCKETS = ['core', 'graphql'] as const

type PRBranchLookupCandidate = Pick<
  GitHubPRRefreshCandidate,
  'localGitOptions' | 'linkedPRNumber' | 'fallbackPRNumber' | 'fallbackPRSource' | 'currentHeadOid'
>

function hostedReviewOptionArgs(
  candidate: PRBranchLookupCandidate
): [] | [GitHubPRBranchLookupOptions] {
  const options: GitHubPRBranchLookupOptions = {}
  if (candidate.localGitOptions?.wslDistro) {
    options.localGitExecOptions = { wslDistro: candidate.localGitOptions.wslDistro }
  }
  if (
    candidate.linkedPRNumber == null &&
    candidate.fallbackPRNumber != null &&
    candidate.fallbackPRSource != null
  ) {
    options.acceptMergedFallbackPR = true
  }
  if (typeof candidate.currentHeadOid === 'string' && candidate.currentHeadOid.trim().length > 0) {
    options.currentHeadOid = candidate.currentHeadOid.trim()
  }
  return Object.keys(options).length > 0 ? [options] : []
}

export async function queryGitHubPullRequest(
  candidate: GitHubPRRefreshCandidate
): Promise<PRRefreshOutcome> {
  return getPRForBranchOutcome(
    candidate.repoPath,
    candidate.branch,
    candidate.linkedPRNumber ?? null,
    candidate.connectionId ?? null,
    candidate.linkedPRNumber == null ? (candidate.fallbackPRNumber ?? null) : null,
    ...hostedReviewOptionArgs(candidate)
  )
}

export async function getGitHubRefreshRateLimitRetryAt(
  candidate: GitHubPRRefreshCandidate,
  warmSharedRateLimit: boolean
): Promise<number | null> {
  const executionOptions = ghRepoExecOptions(
    githubRepoContext(candidate.repoPath, candidate.connectionId, candidate.localGitOptions)
  )
  const repository = await getOriginGitHubApiRepository(
    candidate.repoPath,
    candidate.connectionId,
    executionOptions
  )
  if (warmSharedRateLimit && spendsSharedGitHubComQuota(repository, executionOptions)) {
    await getRateLimit()
  }
  const blockedGuard = REFRESH_RATE_LIMIT_BUCKETS.map((bucket) =>
    repositoryRateLimitGuard(repository, bucket, executionOptions)
  ).find((guard) => guard.blocked)
  return blockedGuard?.blocked ? blockedGuard.resetAt * 1000 : null
}

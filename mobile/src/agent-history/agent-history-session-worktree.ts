import { isRuntimePathAbsolute } from '../../../src/shared/cross-platform-path'
import {
  createWslAliasedPathInsideOrEqualMatcher,
  normalizedWslPathCandidateAliases,
  wslAliasedPathDepth
} from '../../../src/shared/wsl-path-aliases'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { splitWorktreeIdForFilesystem } from '../../../src/shared/worktree/id'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'

export type MobileAgentHistorySessionWorktreeStatus = 'current' | 'active' | 'archived'

export type MobileAgentHistorySessionWorktreeInfo = {
  status: MobileAgentHistorySessionWorktreeStatus
  worktreeId: string
  path: string
}

type WorktreeCandidate = {
  worktree: WorktreeWithPriorIds
  path: string
  pathDepth: number
  ownsNormalizedCwd: (normalizedCwd: string) => boolean
  source: 'current-path' | 'prior-path'
}

type WorktreeWithPriorIds = Worktree & {
  priorWorktreeIds?: readonly string[]
}

export function resolveMobileAgentHistorySessionWorktree(args: {
  session: Pick<AiVaultSession, 'cwd' | 'executionHostId'>
  worktrees: readonly Worktree[]
  activeWorktreeId: string | null
}): MobileAgentHistorySessionWorktreeInfo | null {
  if (!args.session.cwd) {
    return null
  }
  const sessionHostId = normalizeExecutionHostId(args.session.executionHostId)
  const cwdAliases = normalizedWslPathCandidateAliases(args.session.cwd)
  const best = findBestMobileWorktreeCandidate(
    buildMobileWorktreeCandidates(args.worktrees),
    sessionHostId,
    cwdAliases
  )
  if (!best) {
    return null
  }

  return {
    status:
      best.worktree.worktreeId === args.activeWorktreeId
        ? 'current'
        : best.worktree.isArchived
          ? 'archived'
          : 'active',
    worktreeId: best.worktree.worktreeId,
    path: best.path
  }
}

function findBestMobileWorktreeCandidate(
  candidates: readonly WorktreeCandidate[],
  sessionHostId: AiVaultSession['executionHostId'] | null,
  normalizedCwdAliases: readonly string[]
): WorktreeCandidate | null {
  let best: WorktreeCandidate | null = null
  for (const candidate of candidates) {
    const worktreeHostId = normalizeExecutionHostId(candidate.worktree.hostId)
    if (sessionHostId && worktreeHostId && worktreeHostId !== sessionHostId) {
      continue
    }
    if (!normalizedCwdAliases.some(candidate.ownsNormalizedCwd)) {
      continue
    }
    if (!best || compareWorktreeCandidates(candidate, best) < 0) {
      best = candidate
    }
  }
  return best
}

export function canResumeInMobileSessionWorktree(
  worktreeInfo: MobileAgentHistorySessionWorktreeInfo | null
): boolean {
  return Boolean(worktreeInfo && worktreeInfo.status !== 'archived')
}

function buildMobileWorktreeCandidates(worktrees: readonly Worktree[]): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = []
  for (const worktree of worktrees as readonly WorktreeWithPriorIds[]) {
    if (hasUsablePath(worktree.path)) {
      candidates.push({
        worktree,
        path: worktree.path,
        pathDepth: wslAliasedPathDepth(worktree.path),
        ownsNormalizedCwd: createWslAliasedPathInsideOrEqualMatcher(worktree.path),
        source: 'current-path'
      })
    }
    for (const priorWorktreeId of worktree.priorWorktreeIds ?? []) {
      const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
      if (!parsed || parsed.repoId !== worktree.repoId || !hasUsablePath(parsed.worktreePath)) {
        continue
      }
      candidates.push({
        worktree,
        path: parsed.worktreePath,
        pathDepth: wslAliasedPathDepth(parsed.worktreePath),
        ownsNormalizedCwd: createWslAliasedPathInsideOrEqualMatcher(parsed.worktreePath),
        source: 'prior-path'
      })
    }
  }
  return candidates
}

function hasUsablePath(pathValue: string): boolean {
  return Boolean(pathValue.trim() && isRuntimePathAbsolute(pathValue))
}

function compareWorktreeCandidates(left: WorktreeCandidate, right: WorktreeCandidate): number {
  const depthDifference = right.pathDepth - left.pathDepth
  if (depthDifference !== 0) {
    return depthDifference
  }
  if (left.source === right.source) {
    return 0
  }
  return left.source === 'current-path' ? -1 : 1
}

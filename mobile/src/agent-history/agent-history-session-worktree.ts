import { isRuntimePathAbsolute } from '../../../src/shared/cross-platform-path'
import {
  isWslAliasedPathInsideOrEqual,
  wslAliasedPathDepth
} from '../../../src/shared/wsl-path-aliases'
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
  source: 'current-path' | 'prior-path'
}

type WorktreeWithPriorIds = Worktree & {
  priorWorktreeIds?: readonly string[]
}

export function resolveMobileAgentHistorySessionWorktree(args: {
  session: Pick<AiVaultSession, 'cwd'>
  worktrees: readonly Worktree[]
  activeWorktreeId: string | null
}): MobileAgentHistorySessionWorktreeInfo | null {
  if (!args.session.cwd) {
    return null
  }
  const sessionCwd = args.session.cwd

  const candidates = buildMobileWorktreeCandidates(args.worktrees)
    .filter((candidate) => isWslAliasedPathInsideOrEqual(candidate.path, sessionCwd))
    .sort(compareWorktreeCandidates)
  const best = candidates[0]
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

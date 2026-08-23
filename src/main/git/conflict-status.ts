import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitConflictKind,
  GitConflictOperation,
  GitFileStatus,
  GitStatusEntry
} from '../../shared/git-status-types'
import { decodeGitCQuotedPath } from '../../shared/git-cquoted-path'
import { gitExecFileAsync } from './runner'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { runWithGitReadCacheInvalidation } from './git-read-cache'

export async function parseUnmergedEntry(
  worktreePath: string,
  line: string
): Promise<GitStatusEntry | null> {
  // Why: porcelain v2 `u` records are space-separated (not tab); path is field 10+ and may contain spaces, so join the tail.
  const parts = line.split(' ')
  const xy = parts[1]
  const modeStage1 = parts[3]
  const modeStage2 = parts[4]
  const modeStage3 = parts[5]
  const filePath = decodeGitCQuotedPath(parts.slice(10).join(' '))
  if (!filePath) {
    return null
  }

  // Why: submodule conflicts (mode 160000) are out of scope for v1 — they need different resolution UX.
  if ([modeStage1, modeStage2, modeStage3].some((mode) => mode === '160000')) {
    return null
  }

  const conflictKind = parseConflictKind(xy)
  if (!conflictKind) {
    return null
  }

  // Why: porcelain v2 `u` records lack rename-origin metadata, so oldPath is intentionally omitted.
  return {
    path: filePath,
    area: 'unstaged',
    status: await getConflictCompatibilityStatus(worktreePath, filePath, conflictKind),
    conflictKind,
    conflictStatus: 'unresolved'
  }
}

function parseConflictKind(xy: string): GitConflictKind | null {
  switch (xy) {
    case 'UU':
      return 'both_modified'
    case 'AA':
      return 'both_added'
    case 'DD':
      return 'both_deleted'
    case 'AU':
      return 'added_by_us'
    case 'UA':
      return 'added_by_them'
    case 'DU':
      return 'deleted_by_us'
    case 'UD':
      return 'deleted_by_them'
    default:
      return null
  }
}

// Why: `status` here is a rendering-compat choice for icon/color plumbing, not semantic; the conflict badge carries the real meaning.
// Why: for deleted_by_*/added_by_* variants Git's result depends on merge strategy, so check the filesystem.
async function getConflictCompatibilityStatus(
  worktreePath: string,
  filePath: string,
  conflictKind: GitConflictKind
): Promise<GitFileStatus> {
  if (conflictKind === 'both_modified' || conflictKind === 'both_added') {
    return 'modified'
  }

  if (conflictKind === 'both_deleted') {
    return 'deleted'
  }

  try {
    return existsSync(path.join(worktreePath, filePath)) ? 'modified' : 'deleted'
  } catch {
    // Why: on an fs check failure, 'modified' is safer — it keeps the row visible rather than falsely showing 'deleted'.
    return 'modified'
  }
}

// Why: the git-status → existsSync race can miss a transient HEAD; fall back to 'unknown' for one poll cycle.
// Why: detect rebase from rebase-merge/ or rebase-apply/ dirs (persist all steps), not REBASE_HEAD (partial, lingers → stale badge).
export async function detectConflictOperation(worktreePath: string): Promise<GitConflictOperation> {
  const gitDir = await resolveGitDir(worktreePath)
  const mergeHead = path.join(gitDir, 'MERGE_HEAD')
  const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD')
  const rebaseMergeDir = path.join(gitDir, 'rebase-merge')
  const rebaseApplyDir = path.join(gitDir, 'rebase-apply')

  let hasMergeHead = false
  let hasCherryPickHead = false
  let hasRebaseDir = false

  try {
    hasMergeHead = existsSync(mergeHead)
    hasCherryPickHead = existsSync(cherryPickHead)
    hasRebaseDir = existsSync(rebaseMergeDir) || existsSync(rebaseApplyDir)
  } catch {
    return 'unknown'
  }

  if (hasMergeHead) {
    return 'merge'
  }
  if (hasRebaseDir) {
    return 'rebase'
  }
  if (hasCherryPickHead) {
    return 'cherry-pick'
  }
  return 'unknown'
}

export async function abortMerge(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['merge', '--abort'], gitOptionsForWorktree(worktreePath, options))
  )
}

export async function abortRebase(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['rebase', '--abort'], gitOptionsForWorktree(worktreePath, options))
  )
}

export async function resolveGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')

  try {
    const dotGitContents = await readFile(dotGitPath, 'utf-8')
    const match = dotGitContents.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      return path.resolve(worktreePath, match[1])
    }
  } catch {
    // `.git` is likely a directory in a non-worktree checkout.
  }

  return dotGitPath
}

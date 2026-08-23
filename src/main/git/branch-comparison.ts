import type {
  GitBranchChangeEntry,
  GitBranchCompareResult,
  GitBranchCompareSummary,
  GitDiffResult
} from '../../shared/git-diff-compare-types'
import { parseNumstat } from '../../shared/git-uncommitted-line-stats'
import { readBranchCompareHead } from '../../shared/git-branch-compare-head'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import { resolveWorktreeBaseCommitOid } from './worktree-base-ref-probe'
import { gitExecFileAsync } from './runner'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { buildDiffResult, readGitBlobAtOidPath } from './git-blob-content'
import { runGitDiffRead } from './git-diff-read-cache'
import { parseBranchChangeLine } from './git-change-entry-parser'
import {
  countAheadCommits,
  resolveCompareRef,
  resolveMergeBase,
  resolveRefOid
} from './git-comparison-refs'

const MAX_GIT_SHOW_BYTES = 10 * 1024 * 1024

export async function getBranchCompare(
  worktreePath: string,
  baseRef: string,
  options: GitRuntimeOptions = {}
): Promise<GitBranchCompareResult> {
  const summary: GitBranchCompareSummary = {
    baseRef,
    baseOid: null,
    compareRef: 'HEAD',
    headOid: null,
    mergeBase: null,
    changedFiles: 0,
    status: 'loading'
  }

  // The base-ref probe peels to a commit. Only branch refs are guaranteed to store
  // commits; remote-tracking refs may store annotated tags whose raw oid must be preserved.
  const reusableProbedOidByRef = new Map<string, string>()
  const { compareRef, headOidResult, baseOidResult } = await readBranchCompareHead({
    readCompareRef: () => resolveCompareRef(worktreePath, options),
    resolveBaseRef: () =>
      // Why: short refs like "origin/main" can collide with a local branch; use the proven remote-tracking ref.
      resolveWorktreeAddBaseRef(baseRef, async (qualifiedRef) => {
        const oid = await resolveWorktreeBaseCommitOid(worktreePath, qualifiedRef, options)
        if (oid !== null && qualifiedRef.startsWith('refs/heads/')) {
          reusableProbedOidByRef.set(qualifiedRef, oid)
        }
        return oid !== null
      }),
    readHeadOid: () => resolveRefOid(worktreePath, 'HEAD', options),
    readBaseOid: (ref) => {
      const reusableOid = reusableProbedOidByRef.get(ref)
      return reusableOid === undefined
        ? resolveRefOid(worktreePath, ref, options)
        : Promise.resolve(reusableOid)
    }
  })
  summary.compareRef = compareRef

  let headOid = ''
  let baseOid = ''
  if (headOidResult.ok) {
    headOid = headOidResult.oid
    summary.headOid = headOid
  } else {
    if (baseOidResult.ok) {
      baseOid = baseOidResult.oid
      summary.baseOid = baseOid
      // Why: an unborn branch (new remote worktree) has no changes yet; a compare error would look broken.
      summary.changedFiles = 0
      summary.commitsAhead = 0
      summary.status = 'ready'
      return { summary, entries: [] }
    }
    summary.status = 'unborn-head'
    summary.errorMessage =
      'This branch does not have a committed HEAD yet, so compare-to-base is unavailable.'
    return { summary, entries: [] }
  }

  if (baseOidResult.ok) {
    baseOid = baseOidResult.oid
    summary.baseOid = baseOid
  } else {
    summary.status = 'invalid-base'
    summary.errorMessage = `Base ref ${baseRef} could not be resolved in this repository.`
    return { summary, entries: [] }
  }

  let mergeBase = ''
  try {
    mergeBase = await resolveMergeBase(worktreePath, baseOid, headOid, options)
    summary.mergeBase = mergeBase
  } catch {
    summary.status = 'no-merge-base'
    summary.errorMessage = `This branch and ${baseRef} do not share a merge base, so compare-to-base is unavailable.`
    return { summary, entries: [] }
  }

  try {
    const [entries, commitsAhead] = await Promise.all([
      loadBranchChanges(worktreePath, mergeBase, headOid, options),
      countAheadCommits(worktreePath, baseOid, headOid, options)
    ])
    summary.changedFiles = entries.length
    summary.commitsAhead = commitsAhead
    summary.status = 'ready'
    return { summary, entries }
  } catch (error) {
    summary.status = 'error'
    summary.errorMessage = error instanceof Error ? error.message : 'Failed to load branch compare'
    return { summary, entries: [] }
  }
}

export async function getBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions = {}
): Promise<GitDiffResult> {
  return runGitDiffRead(
    ['branchDiff', worktreePath, args.headOid, args.mergeBase, args.filePath, args.oldPath ?? null],
    options,
    () => loadBranchDiff(worktreePath, args, options)
  )
}

async function loadBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  try {
    const leftPath = args.oldPath ?? args.filePath
    // Why concurrent: the two sides are independent `git show` spawns, so awaiting
    // them in series doubles the latency of every diff the review panel opens.
    const [leftBlob, rightBlob] = await Promise.all([
      readGitBlobAtOidPath(worktreePath, args.mergeBase, leftPath, options),
      readGitBlobAtOidPath(worktreePath, args.headOid, args.filePath, options)
    ])

    return buildDiffResult(
      leftBlob.content,
      rightBlob.content,
      leftBlob.isBinary,
      rightBlob.isBinary,
      args.filePath
    )
  } catch {
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}

async function loadBranchChanges(
  worktreePath: string,
  mergeBase: string,
  headOid: string,
  options: GitRuntimeOptions = {}
): Promise<GitBranchChangeEntry[]> {
  // Why: core.quotePath=false keeps real UTF-8 paths — see getStatus rationale.
  const gitOptions = {
    ...gitOptionsForWorktree(worktreePath, options),
    maxBuffer: MAX_GIT_SHOW_BYTES
  }
  // Why: both diffs are independent, so run them concurrently instead of serializing.
  const [{ stdout }, { stdout: numstat }] = await Promise.all([
    gitExecFileAsync(
      ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', mergeBase, headOid],
      gitOptions
    ),
    gitExecFileAsync(
      ['-c', 'core.quotePath=false', 'diff', '-z', '--numstat', '-M', '-C', mergeBase, headOid],
      gitOptions
    )
  ])
  const statsByPath = parseNumstat(numstat)

  const entries: GitBranchChangeEntry[] = []
  // Why: split on /\r?\n/ so Git's CRLF output on Windows leaves no trailing \r in paths.
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const entry = parseBranchChangeLine(line)
    if (entry) {
      entries.push({ ...entry, ...statsByPath.get(entry.path) })
    }
  }
  return entries
}

import { stat } from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { isUnsupportedWorktreeListZError } from '../../shared/git-worktree-command-capabilities'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { gitExecFileAsync } from './runner'
import type { GitWorktreeExecOptions } from './worktree-execution-options'
import { normalizeMainWorktreePath, translateWorktreePath } from './worktree-paths'
import { parseWorktreeList } from './worktree-list-output'
import { annotateSparseCheckoutStatus } from './worktree-sparse-checkout'

export const WORKTREE_LIST_TIMEOUT_MS = 30_000
const PRUNABLE_EXISTENCE_PROBE_CONCURRENCY = 8

async function readWorktreeList(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const execOptions = {
    cwd: repoPath,
    ...options,
    timeout: options.timeout ?? WORKTREE_LIST_TIMEOUT_MS
  }
  return withLocalGitCapabilityCacheForExecution(
    { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
    (capabilities) =>
      capabilities.runWithFallback(
        'worktree-list-z',
        async () => {
          const { stdout } = await gitExecFileAsync(
            ['worktree', 'list', '--porcelain', '-z'],
            execOptions
          )
          return normalizeMainWorktreePath(
            repoPath,
            parseWorktreeList(stdout, { nulDelimited: true }),
            options
          )
        },
        async () => {
          const { stdout } = await gitExecFileAsync(
            ['worktree', 'list', '--porcelain'],
            execOptions
          )
          const normalized = await normalizeMainWorktreePath(
            repoPath,
            parseWorktreeList(stdout),
            options
          )
          return annotatePrunableByExistence(normalized, repoPath, options)
        },
        isUnsupportedWorktreeListZError
      )
  )
}

async function annotatePrunableByExistence(
  worktrees: GitWorktreeInfo[],
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0
  async function probeNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      if (
        !worktree ||
        worktree.isMainWorktree ||
        worktree.isBare ||
        worktree.locked ||
        worktree.prunable
      ) {
        continue
      }
      try {
        await stat(translateWorktreePath(worktree.path, repoPath, options))
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          annotated[index] = { ...worktree, prunable: true }
        }
      }
    }
  }
  const workerCount = Math.min(PRUNABLE_EXISTENCE_PROBE_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => probeNext()))
  return annotated
}

async function readTranslatedWorktreeGraph(
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<GitWorktreeInfo[]> {
  return (await readWorktreeList(repoPath, options)).map((worktree) => {
    const translatedPath = translateWorktreePath(worktree.path, repoPath, options)
    return translatedPath === worktree.path ? worktree : { ...worktree, path: translatedPath }
  })
}

export async function listWorktreeGraph(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  try {
    return await readTranslatedWorktreeGraph(repoPath, options)
  } catch (error) {
    if (await shouldTreatListingErrorAsEmpty(repoPath, error)) {
      return []
    }
    console.warn(`[git/worktree] listWorktreeGraph failed for ${repoPath}:`, error)
    return []
  }
}

const inFlightWorktreeScans = new Map<string, Promise<GitWorktreeInfo[]>>()
const worktreeScanGenerations = new Map<string, number>()

function hasInFlightWorktreeScanForRepo(repoPath: string): boolean {
  const keyPrefix = `${repoPath}\0`
  for (const key of inFlightWorktreeScans.keys()) {
    if (key.startsWith(keyPrefix)) {
      return true
    }
  }
  return false
}

export function bumpWorktreeScanGeneration(repoPath: string): void {
  if (!hasInFlightWorktreeScanForRepo(repoPath)) {
    return
  }
  worktreeScanGenerations.set(repoPath, (worktreeScanGenerations.get(repoPath) ?? 0) + 1)
}

function pruneWorktreeScanGeneration(repoPath: string): void {
  if (worktreeScanGenerations.has(repoPath) && !hasInFlightWorktreeScanForRepo(repoPath)) {
    worktreeScanGenerations.delete(repoPath)
  }
}

export function getWorktreeScanCacheSizes(): { inFlight: number; generations: number } {
  return { inFlight: inFlightWorktreeScans.size, generations: worktreeScanGenerations.size }
}

export function resetWorktreeScanCache(): void {
  inFlightWorktreeScans.clear()
  worktreeScanGenerations.clear()
}

export function listWorktrees(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  if (options.signal) {
    return listWorktreesUnshared(repoPath, options)
  }
  const generation = worktreeScanGenerations.get(repoPath) ?? 0
  const timeout = options.timeout ?? WORKTREE_LIST_TIMEOUT_MS
  const key = `${repoPath}\0${options.wslDistro ?? ''}\0${timeout}\0${generation}`
  const inFlight = inFlightWorktreeScans.get(key)
  if (inFlight) {
    return inFlight
  }
  const scan = listWorktreesUnshared(repoPath, options).finally(() => {
    if (inFlightWorktreeScans.get(key) === scan) {
      inFlightWorktreeScans.delete(key)
    }
    pruneWorktreeScanGeneration(repoPath)
  })
  inFlightWorktreeScans.set(key, scan)
  return scan
}

async function listWorktreesUnshared(
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<GitWorktreeInfo[]> {
  try {
    return annotateSparseCheckoutStatus(await readTranslatedWorktreeGraph(repoPath, options))
  } catch (error) {
    if (await shouldTreatListingErrorAsEmpty(repoPath, error)) {
      return []
    }
    console.warn(`[git/worktree] listWorktrees failed for ${repoPath}:`, error)
    return []
  }
}

export async function listWorktreesStrict(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const worktrees = (await readWorktreeList(repoPath, options)).map((worktree) => {
    const translatedPath = translateWorktreePath(worktree.path, repoPath, options)
    return translatedPath === worktree.path ? worktree : { ...worktree, path: translatedPath }
  })
  return annotateSparseCheckoutStatus(worktrees)
}

async function shouldTreatListingErrorAsEmpty(repoPath: string, error: unknown): Promise<boolean> {
  if (getErrorCode(error) === 'ENOENT') {
    try {
      await stat(repoPath)
    } catch (statError) {
      if (getErrorCode(statError) === 'ENOENT') {
        console.warn(`[git/worktree] repo path missing; skipping worktree list: ${repoPath}`)
        return true
      }
    }
  }
  return /not a git repository/i.test(getErrorText(error))
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function getErrorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error)
  }
  const parts: string[] = []
  if ('message' in error && typeof error.message === 'string') {
    parts.push(error.message)
  }
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr)
  }
  return parts.join('\n')
}

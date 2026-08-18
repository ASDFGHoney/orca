import type { RuntimeFileListResult } from '../../../shared/runtime-types'
import {
  buildExcludePathPrefixes,
  shouldExcludeQuickOpenRelPath
} from '../../../shared/quick-open-filter'
import { QuickOpenPathRanker } from '../../../shared/quick-open-path-search'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

const CACHE_LIMIT = 8
const CACHE_TTL_MS = 30_000

type EnvironmentTarget = Extract<RuntimeClientTarget, { kind: 'environment' }>
type CacheEntry = {
  expiresAt: number
  load: Promise<RuntimeFileListResult>
}

const inventoryCache = new Map<string, CacheEntry>()

function cacheKey(
  target: EnvironmentTarget,
  worktreeSelector: string,
  worktreePath: string | null | undefined
): string {
  return JSON.stringify([
    target.environmentId,
    getRuntimeEnvironmentRevision(target.environmentId) ?? 'unknown',
    worktreeSelector,
    worktreePath ?? null
  ])
}

export function clearLegacyQuickOpenInventoryCacheForTests(): void {
  inventoryCache.clear()
}

export function hasCachedLegacyQuickOpenInventory(
  target: EnvironmentTarget,
  worktreeSelector: string,
  worktreePath: string | null | undefined
): boolean {
  const entry = inventoryCache.get(cacheKey(target, worktreeSelector, worktreePath))
  return entry !== undefined && entry.expiresAt > Date.now()
}

async function loadLegacyQuickOpenInventory(
  target: EnvironmentTarget,
  worktreeSelector: string,
  worktreePath: string | null | undefined
): Promise<RuntimeFileListResult> {
  const key = cacheKey(target, worktreeSelector, worktreePath)
  const now = Date.now()
  const expectedEnvironmentPairingRevision = getRuntimeEnvironmentRevision(target.environmentId)
  const cached = inventoryCache.get(key)
  if (cached && cached.expiresAt > now) {
    inventoryCache.delete(key)
    inventoryCache.set(key, cached)
    return cached.load
  }
  inventoryCache.delete(key)

  let entry: CacheEntry
  // Old hosts cannot stop listMobileFiles mid-scan; share one request instead of aborting and
  // restarting the same scan for every debounced query.
  const load = callRuntimeRpc<RuntimeFileListResult>(
    target,
    'files.list',
    { worktree: worktreeSelector },
    { timeoutMs: 15_000, expectedEnvironmentPairingRevision }
  )
    .then((result) => {
      entry.expiresAt = Date.now() + CACHE_TTL_MS
      return result
    })
    .catch((error) => {
      if (inventoryCache.get(key) === entry) {
        inventoryCache.delete(key)
      }
      throw error
    })
  entry = { expiresAt: now + CACHE_TTL_MS, load }
  inventoryCache.set(key, entry)
  while (inventoryCache.size > CACHE_LIMIT) {
    const oldest = inventoryCache.keys().next().value as string | undefined
    if (!oldest) {
      break
    }
    inventoryCache.delete(oldest)
  }
  return load
}

export async function searchLegacyQuickOpenInventory(args: {
  target: EnvironmentTarget
  worktreeSelector: string
  query: string
  limit: number
  worktreePath: string | null | undefined
  excludePaths: string[] | undefined
}): Promise<{ files: string[]; truncated: boolean }> {
  const result = await loadLegacyQuickOpenInventory(
    args.target,
    args.worktreeSelector,
    args.worktreePath
  )
  const excludePrefixes = buildExcludePathPrefixes(
    args.worktreePath ?? result.rootPath,
    args.excludePaths
  )
  const ranker = new QuickOpenPathRanker(args.query, args.limit)
  for (const entry of result.files) {
    if (!shouldExcludeQuickOpenRelPath(entry.relativePath, excludePrefixes)) {
      ranker.consider(entry.relativePath)
    }
  }
  const matches = ranker.result()
  return {
    files: matches.paths,
    truncated: result.truncated || matches.totalCount > args.limit
  }
}

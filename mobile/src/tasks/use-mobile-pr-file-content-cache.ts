import { useCallback, useState } from 'react'
import type {
  GitHubPRFileContents,
  GitHubRepositoryIdentity
} from '../../../src/shared/github/pull-request-types'
import {
  MobilePrFileContentCache,
  createMobilePrFileContentKey,
  createMobilePrFileContentScope,
  getMobilePrFileContentsForScope,
  type MobilePrFileContentKeyInput
} from './mobile-pr-file-content-cache'

type MobilePrScopeTaskItem = {
  provider: string
  source: unknown
} | null

type MobilePrScopeDetail = {
  provider: string
  headSha?: unknown
  baseSha?: unknown
} | null

type MobileProjectPrScopeItem = {
  itemType: string
  content: { number?: unknown }
} | null

type MobileProjectPrScopeRepo = { id?: unknown } | null

type MobilePrFileContentLoad = () => Promise<unknown>
type MobilePrFileContentErrorSetter = (message: string) => void
type MobilePrFileContentCacheView = {
  activeScope: string | null
  cache: MobilePrFileContentCache
  snapshot: ReturnType<MobilePrFileContentCache['snapshot']>
  loadingPath: string | null
}

export function createMobileItemPrFileContentScope(
  item: MobilePrScopeTaskItem,
  detail: MobilePrScopeDetail
): string | null {
  const source =
    item?.source && typeof item.source === 'object'
      ? (item.source as { type?: unknown; repoId?: unknown; number?: unknown })
      : null
  if (
    item?.provider !== 'github' ||
    source?.type !== 'pr' ||
    typeof source.repoId !== 'string' ||
    typeof source.number !== 'number' ||
    detail?.provider !== 'github' ||
    typeof detail.headSha !== 'string' ||
    !detail.headSha ||
    typeof detail.baseSha !== 'string' ||
    !detail.baseSha
  ) {
    return null
  }
  return createMobilePrFileContentScope({
    source: 'item',
    repoId: source.repoId,
    prNumber: source.number,
    headSha: detail.headSha,
    baseSha: detail.baseSha
  })
}

export function createMobileProjectPrFileContentScope(
  item: MobileProjectPrScopeItem,
  repo: MobileProjectPrScopeRepo,
  detail: MobilePrScopeDetail,
  repository?: GitHubRepositoryIdentity | null
): string | null {
  if (
    item?.itemType !== 'PULL_REQUEST' ||
    typeof item.content.number !== 'number' ||
    typeof repo?.id !== 'string' ||
    detail?.provider !== 'github' ||
    typeof detail.headSha !== 'string' ||
    !detail.headSha ||
    typeof detail.baseSha !== 'string' ||
    !detail.baseSha
  ) {
    return null
  }
  return createMobilePrFileContentScope({
    source: 'project',
    repoId: repo.id,
    prNumber: item.content.number,
    repository,
    headSha: detail.headSha,
    baseSha: detail.baseSha
  })
}

export function useMobilePrFileContentCache(activeScope: string | null): {
  clear: () => void
  contents: Readonly<Record<string, GitHubPRFileContents | undefined>>
  load: (
    scope: string,
    file: MobilePrFileContentKeyInput,
    loadContents: MobilePrFileContentLoad,
    setError: MobilePrFileContentErrorSetter
  ) => Promise<void>
  loadingPath: string | null
} {
  const [view, setView] = useState(() => createMobilePrFileContentCacheView(activeScope))
  let currentView = view
  if (view.activeScope !== activeScope) {
    currentView = createMobilePrFileContentCacheView(activeScope)
    setView(currentView)
  }
  const { cache } = currentView
  const clear = useCallback(() => {
    setView((current) => createMobilePrFileContentCacheView(current.activeScope))
  }, [])

  const load = useCallback(
    async (
      scope: string,
      file: MobilePrFileContentKeyInput,
      loadContents: MobilePrFileContentLoad,
      setError: MobilePrFileContentErrorSetter
    ): Promise<void> => {
      const key = createMobilePrFileContentKey(file)
      const selection = cache.select(scope, key)
      if (selection.scopeChanged) {
        const snapshot = cache.snapshot()
        setView((current) => (current.cache === cache ? { ...current, snapshot } : current))
      }
      if (selection.contents) {
        setView((current) =>
          current.cache === cache ? { ...current, loadingPath: null } : current
        )
        return
      }
      const token = cache.beginRequest(scope, key)
      setView((current) =>
        current.cache === cache ? { ...current, loadingPath: file.path } : current
      )
      setError('')
      try {
        const result = await loadContents()
        if (!isGitHubPrFileContents(result)) {
          throw new Error('Invalid file contents response')
        }
        const commit = cache.commitRequest(token, result)
        if (commit === 'stale') {
          return
        }
        if (commit === 'too-large') {
          setError('File too large for mobile preview.')
        } else {
          const snapshot = cache.snapshot()
          setView((current) => (current.cache === cache ? { ...current, snapshot } : current))
        }
        setView((current) =>
          current.cache === cache && current.loadingPath === file.path
            ? { ...current, loadingPath: null }
            : current
        )
      } catch (error) {
        if (!cache.rejectRequest(token)) {
          return
        }
        setError(error instanceof Error ? error.message : 'Failed to load file contents')
        setView((current) =>
          current.cache === cache && current.loadingPath === file.path
            ? { ...current, loadingPath: null }
            : current
        )
      }
    },
    [cache]
  )

  return {
    clear,
    contents: getMobilePrFileContentsForScope(currentView.snapshot, activeScope),
    load,
    loadingPath: currentView.loadingPath
  }
}

function createMobilePrFileContentCacheView(
  activeScope: string | null
): MobilePrFileContentCacheView {
  const cache = new MobilePrFileContentCache()
  if (activeScope) {
    cache.activateScope(activeScope)
  }
  return {
    activeScope,
    cache,
    snapshot: cache.snapshot(),
    loadingPath: null
  }
}

function isGitHubPrFileContents(value: unknown): value is GitHubPRFileContents {
  if (!value || typeof value !== 'object') {
    return false
  }
  const contents = value as Partial<GitHubPRFileContents>
  return (
    typeof contents.original === 'string' &&
    typeof contents.modified === 'string' &&
    typeof contents.originalIsBinary === 'boolean' &&
    typeof contents.modifiedIsBinary === 'boolean'
  )
}

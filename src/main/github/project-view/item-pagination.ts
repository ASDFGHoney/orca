import type { GitHubProjectOwnerType, GitHubProjectRow } from '../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import { errorsIndicateParentField, driftError } from './project-error-classification'
import { projectGhExecOptions, runGraphql } from './internals'
import {
  hasParentFieldRetried,
  hasParentFieldWarningLogged,
  markParentFieldRetried,
  markParentFieldWarningLogged,
  ownerScopeKey,
  parentFieldProbeInFlight
} from './cache-state'
import { fetchItemsPageWithRaw, type ItemsPageResult } from './item-page-query'
import { normalizeItem, type RawProjectItem } from './response-normalization'
import { ownerQueryRoot } from './view-configuration-query'

const ITEM_PAGE_SIZE = 100
const MAX_ITEMS = 500

export async function fetchAllItems(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  host?: string
}): Promise<
  | { ok: true; rows: GitHubProjectRow[]; totalCount: number; parentFieldDropped: boolean }
  | { ok: false; error: GitHubProjectViewError; totalCount?: number }
> {
  const scopeKey = ownerScopeKey(args.owner, args.ownerType, args.host)
  const inFlight = parentFieldProbeInFlight.get(scopeKey)
  if (inFlight) {
    await inFlight.catch(() => {})
  }
  let includeParent = !hasParentFieldRetried(scopeKey)
  let parentFieldDropped = !includeParent
  let first: ItemsPageResult
  if (includeParent && !parentFieldProbeInFlight.has(scopeKey)) {
    let resolveProbe: () => void = () => {}
    const probe = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })
    parentFieldProbeInFlight.set(scopeKey, probe)
    const probePromise = (async (): Promise<ItemsPageResult> => {
      try {
        const result = await fetchItemsPageWithRaw({
          ...args,
          first: ITEM_PAGE_SIZE,
          after: null,
          includeParent: true
        })
        // Set state before waking siblings so none duplicate the with-parent probe.
        if (!result.ok && errorsIndicateParentField(result.rawErrors, result.stderr)) {
          markParentFieldRetried(scopeKey)
        }
        return result
      } finally {
        resolveProbe()
        parentFieldProbeInFlight.delete(scopeKey)
      }
    })()
    first = await probePromise
  } else {
    first = await fetchItemsPageWithRaw({
      ...args,
      first: ITEM_PAGE_SIZE,
      after: null,
      includeParent
    })
  }
  if (!first.ok && includeParent && errorsIndicateParentField(first.rawErrors, first.stderr)) {
    markParentFieldRetried(scopeKey)
    includeParent = false
    parentFieldDropped = true
    if (!hasParentFieldWarningLogged(scopeKey)) {
      console.warn(
        `[project-view] Issue.parent is not available for ${args.owner} on this token — retrying without the parent selection.`
      )
      markParentFieldWarningLogged(scopeKey)
    }
    first = await fetchItemsPageWithRaw({
      ...args,
      first: ITEM_PAGE_SIZE,
      after: null,
      includeParent: false
    })
  }
  if (!first.ok) {
    return { ok: false, error: first.error }
  }

  if (first.page.totalCount === undefined || first.page.totalCount === null) {
    return { ok: false, error: driftError('items.totalCount missing') }
  }
  const totalCount = first.page.totalCount
  if (first.page.pageInfo?.hasNextPage === undefined) {
    return { ok: false, error: driftError('items.pageInfo.hasNextPage missing'), totalCount }
  }
  if (!Array.isArray(first.page.nodes)) {
    return { ok: false, error: driftError('items.nodes missing'), totalCount }
  }
  if (totalCount > MAX_ITEMS) {
    return {
      ok: false,
      error: { type: 'too_large', message: `View has ${totalCount} items.` },
      totalCount
    }
  }

  const rows: GitHubProjectRow[] = []
  let position = 0
  const appendNodes = (nodes: (RawProjectItem | null)[]): GitHubProjectViewError | null => {
    for (const node of nodes) {
      if (!node) {
        continue
      }
      const normalized = normalizeItem(node, position)
      if (!normalized.ok) {
        return normalized.drift
      }
      rows.push(normalized.row)
      position++
    }
    return null
  }
  const firstError = appendNodes(first.page.nodes)
  if (firstError) {
    return { ok: false, error: firstError, totalCount }
  }

  let hasNext = first.page.pageInfo.hasNextPage === true
  let cursor: string | null | undefined = first.page.pageInfo.endCursor
  if (hasNext && typeof cursor !== 'string') {
    return {
      ok: false,
      error: driftError('items.pageInfo.endCursor missing with hasNextPage=true'),
      totalCount
    }
  }
  while (hasNext) {
    const next = await fetchItemsPageWithRaw({
      ...args,
      first: ITEM_PAGE_SIZE,
      after: cursor as string,
      includeParent
    })
    if (!next.ok) {
      return { ok: false, error: next.error, totalCount }
    }
    if (!Array.isArray(next.page.nodes)) {
      return { ok: false, error: driftError('items.nodes missing on follow page'), totalCount }
    }
    if (next.page.pageInfo?.hasNextPage === undefined) {
      return {
        ok: false,
        error: driftError('items.pageInfo.hasNextPage missing on follow page'),
        totalCount
      }
    }
    const pageError = appendNodes(next.page.nodes)
    if (pageError) {
      return { ok: false, error: pageError, totalCount }
    }
    hasNext = next.page.pageInfo.hasNextPage === true
    cursor = next.page.pageInfo.endCursor
    if (hasNext && typeof cursor !== 'string') {
      return {
        ok: false,
        error: driftError('items.pageInfo.endCursor missing with hasNextPage=true'),
        totalCount
      }
    }
  }
  return { ok: true, rows, totalCount, parentFieldDropped }
}

export async function fetchItemsCountOnly(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  host?: string
}): Promise<number | null> {
  const root = ownerQueryRoot(args.ownerType)
  const query = `
    query($owner:String!, $num:Int!, $q:String!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          items(first:1, query:$q) { totalCount }
        }
      }
    }
  `
  const result = await runGraphql<
    Record<string, { projectV2?: { items?: { totalCount?: number } | null } | null } | null>
  >(
    query,
    { owner: args.owner, num: args.projectNumber, q: args.query },
    projectGhExecOptions(args.host)
  )
  if (!result.ok) {
    return null
  }
  const count = result.data[root]?.projectV2?.items?.totalCount
  return typeof count === 'number' ? count : null
}

import type {
  GitHubProjectTable,
  GitHubProjectViewLayout,
  GitHubProjectViewSummary
} from '../../shared/github/project-types'
import type {
  GetProjectViewTableResult,
  ListProjectViewsResult
} from '../../shared/github/project-result-types'
import type {
  GetProjectViewTableArgs,
  ListProjectViewsArgs
} from '../../shared/github/project-request-types'
import { githubProjectHost } from '../../shared/github/project-identity'
import { assertPositiveInt, assertSlug } from './project-view/internals'
import { fetchAllItems, fetchItemsCountOnly } from './project-view/item-pagination'
import {
  fetchProjectViewsPage,
  fetchViewFieldsContinuation,
  finalizeView,
  matchesSelector,
  type RawProjectView
} from './project-view/view-configuration-query'
import type { RawProjectV2Field } from './project-view/response-normalization'

export async function getProjectViewTable(
  args: GetProjectViewTableArgs
): Promise<GetProjectViewTableResult> {
  const ownerCheck = assertSlug(args.owner, 'owner')
  if (!ownerCheck.ok) {
    return { ok: false, error: ownerCheck.error }
  }
  const numberCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numberCheck.ok) {
    return { ok: false, error: numberCheck.error }
  }
  if (args.ownerType !== 'organization' && args.ownerType !== 'user') {
    return { ok: false, error: { type: 'validation_error', message: 'Invalid ownerType.' } }
  }

  let cursor: string | null = null
  let project: { id: string; title: string; url: string } | null = null
  let selectedRaw: RawProjectView | null = null
  let matchStrength: 'id' | 'number' | 'name' | 'default' | null = null
  while (true) {
    const page = await fetchProjectViewsPage({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      host: args.host,
      after: cursor
    })
    if (!page.ok) {
      return { ok: false, error: page.error }
    }
    project = page.project
    for (const view of page.views) {
      const match = matchesSelector(view, {
        viewId: args.viewId,
        viewNumber: args.viewNumber,
        viewName: args.viewName
      })
      if (match === 'none') {
        continue
      }
      const rank: Record<typeof match, number> = { id: 4, number: 3, name: 2, default: 1 }
      const currentRank = matchStrength ? rank[matchStrength] : 0
      if (!selectedRaw || rank[match] > currentRank) {
        selectedRaw = view
        matchStrength = match
      }
    }
    // Any match is final because later pages cannot improve the requested selector.
    if (selectedRaw || !page.hasNextPage) {
      break
    }
    cursor = page.endCursor
    if (typeof cursor !== 'string') {
      break
    }
  }
  if (!project) {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  if (!selectedRaw) {
    return { ok: false, error: { type: 'not_found', message: 'Could not find the selected view.' } }
  }

  let extraFields: RawProjectV2Field[] = []
  const fieldsPageInfo = selectedRaw.fields?.pageInfo
  if (
    fieldsPageInfo?.hasNextPage === true &&
    typeof fieldsPageInfo.endCursor === 'string' &&
    selectedRaw.id
  ) {
    const continuation = await fetchViewFieldsContinuation(
      selectedRaw.id,
      fieldsPageInfo.endCursor,
      args.host
    )
    if (!continuation.ok) {
      return { ok: false, error: continuation.error }
    }
    extraFields = continuation.fields
  }
  const finalized = finalizeView(selectedRaw, extraFields)
  if (!finalized.ok) {
    return { ok: false, error: finalized.drift }
  }
  const selectedView = finalized.view
  // Empty string intentionally overrides the stored filter; undefined uses it.
  const effectiveQuery =
    typeof args.queryOverride === 'string' ? args.queryOverride : selectedView.filter

  if (selectedView.layout !== 'TABLE_LAYOUT') {
    const count = await fetchItemsCountOnly({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      query: effectiveQuery,
      host: args.host
    })
    return {
      ok: false,
      error: {
        type: 'unsupported_layout',
        message: `Orca only renders table views. This is a ${selectedView.layout.replace('_LAYOUT', '').toLowerCase()} view.`
      },
      ...(typeof count === 'number' ? { totalCount: count } : {})
    }
  }

  const items = await fetchAllItems({
    owner: args.owner,
    ownerType: args.ownerType,
    projectNumber: args.projectNumber,
    query: effectiveQuery,
    host: args.host
  })
  if (!items.ok) {
    return {
      ok: false,
      error: items.error,
      ...(typeof items.totalCount === 'number' ? { totalCount: items.totalCount } : {})
    }
  }
  const table: GitHubProjectTable = {
    project: {
      id: project.id,
      host: githubProjectHost(args.host),
      owner: args.owner,
      ownerType: args.ownerType,
      number: args.projectNumber,
      title: project.title,
      url: project.url
    },
    selectedView,
    rows: items.rows,
    totalCount: items.totalCount,
    parentFieldDropped: items.parentFieldDropped
  }
  return { ok: true, data: table }
}

export async function listProjectViews(
  args: ListProjectViewsArgs
): Promise<ListProjectViewsResult> {
  const ownerCheck = assertSlug(args.owner, 'owner')
  if (!ownerCheck.ok) {
    return { ok: false, error: ownerCheck.error }
  }
  const numberCheck = assertPositiveInt(args.projectNumber, 'projectNumber')
  if (!numberCheck.ok) {
    return { ok: false, error: numberCheck.error }
  }
  if (args.ownerType !== 'organization' && args.ownerType !== 'user') {
    return { ok: false, error: { type: 'validation_error', message: 'Invalid ownerType.' } }
  }
  const summaries: GitHubProjectViewSummary[] = []
  let cursor: string | null = null
  while (true) {
    const page = await fetchProjectViewsPage({
      owner: args.owner,
      ownerType: args.ownerType,
      projectNumber: args.projectNumber,
      host: args.host,
      after: cursor
    })
    if (!page.ok) {
      return { ok: false, error: page.error }
    }
    for (const view of page.views) {
      if (typeof view.id !== 'string' || typeof view.layout !== 'string') {
        continue
      }
      summaries.push({
        id: view.id,
        number: typeof view.number === 'number' ? view.number : 0,
        name: typeof view.name === 'string' ? view.name : '',
        layout: view.layout as GitHubProjectViewLayout
      })
    }
    if (!page.hasNextPage) {
      break
    }
    cursor = page.endCursor
    if (typeof cursor !== 'string') {
      break
    }
  }
  return { ok: true, views: summaries }
}

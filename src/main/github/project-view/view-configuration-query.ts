import type {
  GitHubProjectField,
  GitHubProjectOwnerType,
  GitHubProjectSort,
  GitHubProjectView,
  GitHubProjectViewLayout
} from '../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import { driftError } from './project-error-classification'
import { projectGhExecOptions, runGraphql, type GraphqlVars } from './internals'
import { normalizeField, type RawProjectV2Field } from './response-normalization'

const VIEWS_PAGE_SIZE = 20
const FIELDS_PAGE_SIZE = 50

export const FIELD_CONFIG_FRAGMENT = `
fragment FieldConfig on ProjectV2FieldConfiguration {
  __typename
  ... on ProjectV2Field { id name dataType }
  ... on ProjectV2SingleSelectField {
    id
    name
    dataType
    options { id name color }
  }
  ... on ProjectV2IterationField {
    id
    name
    dataType
    configuration {
      iterations { id title startDate duration }
      completedIterations { id title startDate duration }
    }
  }
}
`

type RawProjectConfig = {
  id?: string
  title?: string
  url?: string
  views?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    nodes?: (RawProjectView | null)[]
  }
}

export type RawProjectView = {
  id?: string
  number?: number
  name?: string
  layout?: string
  filter?: string | null
  fields?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
    nodes?: (RawProjectV2Field | null)[]
  }
  groupByFields?: { nodes?: (RawProjectV2Field | null)[] }
  sortByFields?: {
    nodes?: ({ direction?: string; field?: RawProjectV2Field | null } | null)[]
  }
}

export function ownerQueryRoot(ownerType: GitHubProjectOwnerType): 'organization' | 'user' {
  return ownerType === 'organization' ? 'organization' : 'user'
}

export async function fetchProjectViewsPage(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  host?: string
  after: string | null
}): Promise<
  | {
      ok: true
      project: { id: string; title: string; url: string }
      views: RawProjectView[]
      hasNextPage: boolean
      endCursor: string | null
    }
  | { ok: false; error: GitHubProjectViewError }
> {
  const root = ownerQueryRoot(args.ownerType)
  const afterArg = args.after ? `, after: $after` : ''
  const afterVar = args.after ? `$after:String!, ` : ''
  const query = `
    query(${afterVar}$owner:String!, $num:Int!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          id title url
          views(first:${VIEWS_PAGE_SIZE}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id number name layout filter
              fields(first:${FIELDS_PAGE_SIZE}) {
                pageInfo { hasNextPage endCursor }
                nodes { ...FieldConfig }
              }
              groupByFields(first:10) { nodes { ...FieldConfig } }
              sortByFields(first:10) {
                nodes { direction field { ...FieldConfig } }
              }
            }
          }
        }
      }
    }
    ${FIELD_CONFIG_FRAGMENT}
  `
  const vars: GraphqlVars = { owner: args.owner, num: args.projectNumber }
  if (args.after) {
    vars.after = args.after
  }
  const result = await runGraphql<Record<string, { projectV2?: RawProjectConfig | null } | null>>(
    query,
    vars,
    projectGhExecOptions(args.host)
  )
  if (!result.ok) {
    return result
  }
  const project = result.data[root]?.projectV2 ?? null
  if (!project || typeof project.id !== 'string') {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  const pageInfo = project.views?.pageInfo
  return {
    ok: true,
    project: { id: project.id, title: project.title ?? '', url: project.url ?? '' },
    views: (project.views?.nodes ?? []).filter((view): view is RawProjectView => view !== null),
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: pageInfo?.endCursor ?? null
  }
}

export async function fetchViewFieldsContinuation(
  viewId: string,
  after: string,
  host?: string
): Promise<
  { ok: true; fields: RawProjectV2Field[] } | { ok: false; error: GitHubProjectViewError }
> {
  // Address the view directly instead of re-walking all views for every field page.
  const query = `
    query($after:String!, $viewId:ID!) {
      node(id:$viewId) {
        ... on ProjectV2View {
          id
          fields(first:${FIELDS_PAGE_SIZE}, after:$after) {
            pageInfo { hasNextPage endCursor }
            nodes { ...FieldConfig }
          }
        }
      }
    }
    ${FIELD_CONFIG_FRAGMENT}
  `
  const collected: RawProjectV2Field[] = []
  let cursor: string | null = after
  while (cursor !== null) {
    const result = await runGraphql<{
      node?: {
        id?: string
        fields?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: (RawProjectV2Field | null)[]
        }
      } | null
    }>(query, { viewId, after: cursor }, projectGhExecOptions(host))
    if (!result.ok) {
      return result
    }
    const view = result.data.node ?? null
    if (!view) {
      return { ok: false, error: driftError('view disappeared during field pagination') }
    }
    collected.push(
      ...(view.fields?.nodes ?? []).filter((field): field is RawProjectV2Field => field !== null)
    )
    const pageInfo = view.fields?.pageInfo
    cursor =
      pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string'
        ? pageInfo.endCursor
        : null
  }
  return { ok: true, fields: collected }
}

export function finalizeView(
  raw: RawProjectView,
  extraFields: RawProjectV2Field[]
): { ok: true; view: GitHubProjectView } | { ok: false; drift: GitHubProjectViewError } {
  if (typeof raw.id !== 'string' || typeof raw.layout !== 'string') {
    return { ok: false, drift: driftError('view missing id or layout') }
  }
  const fields: GitHubProjectField[] = []
  for (const field of [...(raw.fields?.nodes ?? []), ...extraFields]) {
    const normalized = normalizeField(field)
    if (normalized) {
      fields.push(normalized)
    }
  }
  const groupByFields: GitHubProjectField[] = []
  for (const field of raw.groupByFields?.nodes ?? []) {
    const normalized = normalizeField(field)
    if (normalized) {
      groupByFields.push(normalized)
    }
  }
  const sortByFields: GitHubProjectSort[] = []
  for (const sort of raw.sortByFields?.nodes ?? []) {
    if (!sort || (sort.direction !== 'ASC' && sort.direction !== 'DESC')) {
      continue
    }
    const field = normalizeField(sort.field)
    if (field) {
      sortByFields.push({ direction: sort.direction, field })
    }
  }
  return {
    ok: true,
    view: {
      id: raw.id,
      number: typeof raw.number === 'number' ? raw.number : 0,
      name: typeof raw.name === 'string' ? raw.name : '',
      layout: raw.layout as GitHubProjectViewLayout,
      filter: typeof raw.filter === 'string' ? raw.filter : '',
      fields,
      groupByFields,
      sortByFields
    }
  }
}

export function matchesSelector(
  raw: RawProjectView,
  selector: { viewId?: string; viewNumber?: number; viewName?: string }
): 'none' | 'id' | 'number' | 'name' | 'default' {
  if (selector.viewId && raw.id === selector.viewId) {
    return 'id'
  }
  if (selector.viewNumber !== undefined && raw.number === selector.viewNumber) {
    return 'number'
  }
  if (selector.viewName && raw.name === selector.viewName) {
    return 'name'
  }
  if (
    selector.viewId === undefined &&
    selector.viewNumber === undefined &&
    selector.viewName === undefined &&
    raw.layout === 'TABLE_LAYOUT'
  ) {
    return 'default'
  }
  return 'none'
}

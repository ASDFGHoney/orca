import { ghExecFileAsync } from '../../git/github-cli-runner'
import type { GitHubProjectOwnerType } from '../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import {
  acquire,
  extractExecError,
  noteRepositoryRateLimitSpend,
  projectGhExecOptions,
  projectHostAuthenticationError,
  release,
  repositoryRateLimitGuard
} from './internals'
import {
  classifyProjectError,
  driftError,
  rateLimitedError,
  type GhGraphqlErrorShape
} from './project-error-classification'
import type { RawProjectItem } from './response-normalization'
import { FIELD_CONFIG_FRAGMENT, ownerQueryRoot } from './view-configuration-query'

const FIELD_VALUES_PAGE_SIZE = 100

function itemContentSelection(includeParent: boolean): string {
  const parentFragment = includeParent ? 'parent { number title url }' : ''
  return `
    __typename
    ... on Issue {
      id
      number
      title
      url
      state
      stateReason
      repository { nameWithOwner }
      assignees(first:5) { nodes { login name avatarUrl } }
      labels(first:10) { nodes { name color } }
      issueType { id name color description }
      ${parentFragment}
    }
    ... on PullRequest {
      id
      number
      title
      url
      state
      isDraft
      repository { nameWithOwner }
      assignees(first:5) { nodes { login name avatarUrl } }
      labels(first:10) { nodes { name color } }
    }
    ... on DraftIssue { id title body }
  `
}

const FIELD_VALUES_SELECTION = `
  fieldValues(first:${FIELD_VALUES_PAGE_SIZE}) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { field { ...FieldConfig } name color optionId }
      ... on ProjectV2ItemFieldIterationValue    { field { ...FieldConfig } title startDate duration iterationId }
      ... on ProjectV2ItemFieldTextValue         { field { ...FieldConfig } text }
      ... on ProjectV2ItemFieldNumberValue       { field { ...FieldConfig } number }
      ... on ProjectV2ItemFieldDateValue         { field { ...FieldConfig } date }
      ... on ProjectV2ItemFieldLabelValue        { field { ...FieldConfig } labels(first:10) { nodes { name color } } }
      ... on ProjectV2ItemFieldUserValue         { field { ...FieldConfig } users(first:5) { nodes { login name avatarUrl } } }
    }
  }
`

export type RawItemsPage = {
  totalCount?: number
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  nodes?: (RawProjectItem | null)[]
}
export type ItemsPageResult =
  | { ok: true; page: RawItemsPage }
  | {
      ok: false
      error: GitHubProjectViewError
      rawErrors: GhGraphqlErrorShape[]
      stderr: string
    }

// Unlike runGraphql, this preserves the raw error envelope for the Issue.parent retry.
export async function fetchItemsPageWithRaw(args: {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  query: string
  first: number
  after: string | null
  includeParent: boolean
  host?: string
}): Promise<ItemsPageResult> {
  const authError = await projectHostAuthenticationError(args.host)
  if (authError) {
    return { ok: false, error: authError, rawErrors: [], stderr: '' }
  }
  const root = ownerQueryRoot(args.ownerType)
  const afterArg = args.after ? `, after: $after` : ''
  const afterVar = args.after ? `$after:String!, ` : ''
  const query = `
    query(${afterVar}$owner:String!, $num:Int!, $q:String!, $first:Int!) {
      ${root}(login:$owner) {
        projectV2(number:$num) {
          items(first:$first${afterArg}, query:$q, orderBy:{ field: POSITION, direction: ASC }) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              type
              updatedAt
              content { ${itemContentSelection(args.includeParent)} }
              ${FIELD_VALUES_SELECTION}
            }
          }
        }
      }
    }
    ${FIELD_CONFIG_FRAGMENT}
  `
  const commandArgs = ['api', 'graphql', '-f', `query=${query}`]
  commandArgs.push('-f', `owner=${args.owner}`)
  commandArgs.push('-F', `num=${args.projectNumber}`)
  commandArgs.push('-f', `q=${args.query}`)
  commandArgs.push('-F', `first=${args.first}`)
  if (args.after) {
    commandArgs.push('-f', `after=${args.after}`)
  }

  // GHES traffic has its own quota; only github.com consults the shared snapshot.
  const guard = repositoryRateLimitGuard(args, 'graphql')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard), rawErrors: [], stderr: '' }
  }
  await acquire()
  noteRepositoryRateLimitSpend(args, 'graphql')
  try {
    let stdout = ''
    let stderr = ''
    let execFailed = false
    try {
      const result = await ghExecFileAsync(commandArgs, {
        encoding: 'utf-8',
        ...projectGhExecOptions(args.host)
      })
      stdout = result.stdout
      stderr = result.stderr
    } catch (error) {
      const extracted = extractExecError(error)
      stderr = extracted.stderr
      stdout = extracted.stdout
      execFailed = true
    }
    let parsed: { data?: Record<string, unknown>; errors?: GhGraphqlErrorShape[] } = {}
    try {
      parsed = JSON.parse(stdout)
    } catch {
      if (execFailed) {
        return {
          ok: false,
          error: classifyProjectError(stderr, stdout, args.host),
          rawErrors: [],
          stderr
        }
      }
      return {
        ok: false,
        error: driftError('failed to parse items response'),
        rawErrors: [],
        stderr
      }
    }
    if (execFailed && (!parsed.errors || parsed.errors.length === 0) && !parsed.data) {
      return {
        ok: false,
        error: classifyProjectError(stderr, stdout, args.host),
        rawErrors: [],
        stderr
      }
    }
    if (parsed.errors && parsed.errors.length > 0) {
      return {
        ok: false,
        error: classifyProjectError(stderr, stdout, args.host),
        rawErrors: parsed.errors,
        stderr
      }
    }
    const top = parsed.data?.[root] as { projectV2?: { items?: RawItemsPage } | null } | undefined
    const page = top?.projectV2?.items
    if (!page) {
      return {
        ok: false,
        error: { type: 'not_found', message: 'Project or view not found.' },
        rawErrors: [],
        stderr
      }
    }
    return { ok: true, page }
  } finally {
    release()
  }
}

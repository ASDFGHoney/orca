import {
  assertPositiveInt,
  projectGhExecOptions,
  runGraphql,
  validateSlugArgs,
  type GraphqlVars
} from './internals'
import type {
  GitHubProjectMutationResult,
  ListIssueTypesBySlugResult
} from '../../../shared/github/project-result-types'
import type {
  ListIssueTypesBySlugArgs,
  UpdateIssueTypeBySlugArgs
} from '../../../shared/github/project-request-types'

// Why: Issue Types are a repo-level taxonomy (Bug/Feature/Task/etc) only
// available on repos opted into typed-issues. Empty list (or schema_drift on
// older GitHub deployments) is the legitimate "this repo doesn't use issue
// types" signal — callers should treat it as "no editor".
export async function listIssueTypesBySlug(
  args: ListIssueTypesBySlugArgs
): Promise<ListIssueTypesBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {
    return v
  }
  const query = `
    query($owner:String!, $repo:String!) {
      repository(owner:$owner, name:$repo) {
        issueTypes(first:50) {
          nodes { id name color description }
        }
      }
    }
  `
  const res = await runGraphql<{
    repository?: {
      issueTypes?: {
        nodes?: ({
          id?: string
          name?: string
          color?: string | null
          description?: string | null
        } | null)[]
      } | null
    } | null
  }>(query, { owner: args.owner, repo: args.repo }, projectGhExecOptions(args.host))
  if (!res.ok) {
    // Why: repos without issue types respond with a GraphQL error claiming the
    // `issueTypes` field is unknown. Map that to an empty list so the UI shows
    // "no editor" instead of an angry banner.
    if (res.error.type === 'schema_drift' || res.error.type === 'validation_error') {
      return { ok: true, types: [] }
    }
    return { ok: false, error: res.error }
  }
  const nodes = res.data.repository?.issueTypes?.nodes ?? []
  const types = nodes
    .filter(
      (n): n is NonNullable<typeof n> =>
        n !== null && typeof n.id === 'string' && typeof n.name === 'string'
    )
    .map((n) => ({
      id: n.id as string,
      name: n.name as string,
      color: typeof n.color === 'string' ? n.color : null,
      description: typeof n.description === 'string' ? n.description : null
    }))
  return { ok: true, types }
}

export async function updateIssueTypeBySlug(
  args: UpdateIssueTypeBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {
    return v
  }
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) {
    return { ok: false, error: n.error }
  }
  // Why: `updateIssueIssueType` is the dedicated mutation; passing null for
  // `issueTypeId` clears the type. We resolve the issue id via a lightweight
  // GraphQL lookup because the REST endpoint doesn't accept issue types.
  const lookup = await runGraphql<{
    repository?: { issue?: { id?: string } | null } | null
  }>(
    `query($owner:String!, $repo:String!, $num:Int!) {
       repository(owner:$owner, name:$repo) { issue(number:$num) { id } }
     }`,
    { owner: args.owner, repo: args.repo, num: args.number },
    projectGhExecOptions(args.host)
  )
  if (!lookup.ok) {
    return { ok: false, error: lookup.error }
  }
  const issueId = lookup.data.repository?.issue?.id
  if (!issueId) {
    return { ok: false, error: { type: 'not_found', message: 'Issue not found.' } }
  }
  // Why: build the mutation conditionally so a null clear doesn't have to
  // smuggle a null GraphQL variable through `gh api graphql -f`. The
  // mutation accepts a literal `null` in the input object directly.
  const query = args.issueTypeId
    ? `
        mutation($issueId:ID!, $issueTypeId:ID!) {
          updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $issueTypeId }) {
            issue { id }
          }
        }
      `
    : `
        mutation($issueId:ID!) {
          updateIssueIssueType(input: { issueId: $issueId, issueTypeId: null }) {
            issue { id }
          }
        }
      `
  const vars: GraphqlVars = args.issueTypeId
    ? { issueId, issueTypeId: args.issueTypeId }
    : { issueId }
  const res = await runGraphql<unknown>(query, vars, projectGhExecOptions(args.host))
  if (!res.ok) {
    return { ok: false, error: res.error }
  }
  return { ok: true }
}

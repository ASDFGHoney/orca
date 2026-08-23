import type {
  GitHubProjectOwnerType,
  GitHubProjectSummary
} from '../../../shared/github/project-types'
import type { ListAccessibleProjectsResult } from '../../../shared/github/project-result-types'
import type { ListAccessibleProjectsArgs } from '../../../shared/github/project-request-types'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { rememberOwnerType } from './cache-state'
import { driftError } from './project-error-classification'
import { projectGhExecOptions, runGraphql, type GraphqlVars } from './internals'

const DISCOVERY_PROJECTS_PER_OWNER = 40
const DISCOVERY_MAX_ORGS = 20
const DISCOVERY_ORG_PAGE_SIZE = 20
const DISCOVERY_PROJECTS_PER_ORG = 20

type RawViewerDiscovery = {
  viewer?: {
    login?: string
    projectsV2?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      nodes?: ({
        id?: string
        number?: number
        title?: string
        url?: string
        owner?: { __typename?: string; login?: string }
      } | null)[]
    }
    organizations?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      nodes?: ({
        login?: string
        projectsV2?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: ({ id?: string; number?: number; title?: string; url?: string } | null)[]
        }
      } | null)[]
    }
  }
}

export async function listAccessibleProjects(
  args?: ListAccessibleProjectsArgs
): Promise<ListAccessibleProjectsResult> {
  const host = githubProjectHost(args?.host)
  const viewerProjects: GitHubProjectSummary[] = []
  const orgProjects: GitHubProjectSummary[] = []
  // Preserve per-org failures so discovery can return the usable partial result.
  const partialFailures: { owner: string; message: string }[] = []
  let viewerLogin: string | null = null
  let viewerCursor: string | null = null
  let viewerMore = true
  let viewerFetched = 0
  while (viewerMore && viewerFetched < DISCOVERY_PROJECTS_PER_OWNER) {
    const afterArg = viewerCursor ? ', after: $after' : ''
    const afterVar = viewerCursor ? '$after:String!' : ''
    const query = `
      query${afterVar ? `(${afterVar})` : ''} {
        viewer {
          login
          projectsV2(first:${DISCOVERY_PROJECTS_PER_ORG}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id number title url
              owner { __typename ... on Organization { login } ... on User { login } }
            }
          }
        }
      }
    `
    const vars: GraphqlVars = {}
    if (viewerCursor) {
      vars.after = viewerCursor
    }
    const result = await runGraphql<RawViewerDiscovery>(query, vars, projectGhExecOptions(host))
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
    if (!result.data.viewer) {
      return { ok: false, error: driftError('viewer missing') }
    }
    if (viewerLogin === null) {
      viewerLogin = result.data.viewer.login ?? null
    }
    for (const project of result.data.viewer.projectsV2?.nodes ?? []) {
      if (!project || typeof project.id !== 'string' || typeof project.number !== 'number') {
        continue
      }
      const ownerType: GitHubProjectOwnerType =
        project.owner?.__typename === 'Organization' ? 'organization' : 'user'
      viewerProjects.push({
        id: project.id,
        host,
        owner: project.owner?.login ?? viewerLogin ?? '',
        ownerType,
        number: project.number,
        title: project.title ?? '',
        url: project.url ?? '',
        source: 'viewer'
      })
      viewerFetched++
      if (viewerFetched >= DISCOVERY_PROJECTS_PER_OWNER) {
        break
      }
    }
    const pageInfo = result.data.viewer.projectsV2?.pageInfo
    viewerMore = pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string'
    viewerCursor = viewerMore ? (pageInfo?.endCursor ?? null) : null
  }

  // Fetch one bounded projects page per organization; overflow projects remain paste-accessible.
  let orgCursor: string | null = null
  let orgMore = true
  let orgsSeen = 0
  while (orgMore && orgsSeen < DISCOVERY_MAX_ORGS) {
    const afterArg = orgCursor ? ', after: $orgAfter' : ''
    const afterVar = orgCursor ? '$orgAfter:String!' : ''
    const query = `
      query${afterVar ? `(${afterVar})` : ''} {
        viewer {
          organizations(first:${DISCOVERY_ORG_PAGE_SIZE}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              login
              projectsV2(first:${DISCOVERY_PROJECTS_PER_ORG}) {
                pageInfo { hasNextPage endCursor }
                nodes { id number title url }
              }
            }
          }
        }
      }
    `
    const vars: GraphqlVars = {}
    if (orgCursor) {
      vars.orgAfter = orgCursor
    }
    const result = await runGraphql<RawViewerDiscovery>(query, vars, projectGhExecOptions(host))
    if (!result.ok) {
      partialFailures.push({ owner: '*', message: result.error.message })
      break
    }
    for (const organization of result.data.viewer?.organizations?.nodes ?? []) {
      if (!organization || typeof organization.login !== 'string') {
        continue
      }
      if (orgsSeen >= DISCOVERY_MAX_ORGS) {
        break
      }
      orgsSeen++
      const login = organization.login
      rememberOwnerType(login, 'organization', host)
      let ownerCount = 0
      for (const project of organization.projectsV2?.nodes ?? []) {
        if (!project || typeof project.id !== 'string' || typeof project.number !== 'number') {
          continue
        }
        if (ownerCount >= DISCOVERY_PROJECTS_PER_OWNER) {
          break
        }
        orgProjects.push({
          id: project.id,
          host,
          owner: login,
          ownerType: 'organization',
          number: project.number,
          title: project.title ?? '',
          url: project.url ?? '',
          source: `org:${login}`
        })
        ownerCount++
      }
    }
    const pageInfo = result.data.viewer?.organizations?.pageInfo
    orgMore = pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string'
    orgCursor = orgMore ? (pageInfo?.endCursor ?? null) : null
  }

  if (viewerLogin) {
    rememberOwnerType(viewerLogin, 'user', host)
  }
  return {
    ok: true,
    projects: [...viewerProjects, ...orgProjects],
    ...(partialFailures.length > 0 ? { partialFailures } : {})
  }
}

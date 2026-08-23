import type { GitHubProjectOwnerType } from '../../../shared/github/project-types'
import type {
  GitHubProjectViewError,
  ResolveProjectRefResult
} from '../../../shared/github/project-result-types'
import type { ResolveProjectRefArgs } from '../../../shared/github/project-request-types'
import {
  GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR,
  isGitHubProjectRefInputTooLarge
} from '../../../shared/github/project-ref-input'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { getCachedOwnerType, rememberOwnerType } from './cache-state'
import { isValidOwnerSlug, projectGhExecOptions, runGraphql, type GraphqlVars } from './internals'
import { ownerQueryRoot } from './view-configuration-query'

export type ParsedProjectPaste =
  | { kind: 'org'; owner: string; number: number; host: string; viewNumber?: number }
  | { kind: 'user'; owner: string; number: number; host: string; viewNumber?: number }
  | { kind: 'bare'; owner: string; number: number }

export function parseProjectPaste(input: string, host?: string): ParsedProjectPaste | null {
  const trimmed = input.trim()
  if (!trimmed || isGitHubProjectRefInputTooLarge(trimmed)) {
    return null
  }
  // URL parsing enforces an exact Project path and rejects credentials.
  try {
    const url = new URL(trimmed)
    const allowedHosts = new Set(['github.com', ...(host ? [host.trim().toLowerCase()] : [])])
    const parts = url.pathname.split('/').filter(Boolean)
    const hasView = parts.length === 6 && parts[4] === 'views'
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      !allowedHosts.has(url.host.toLowerCase()) ||
      (parts[0] !== 'orgs' && parts[0] !== 'users') ||
      !isValidOwnerSlug(parts[1]) ||
      parts[2] !== 'projects' ||
      (parts.length !== 4 && !hasView)
    ) {
      return null
    }
    const number = Number(parts[3])
    const viewNumber = hasView ? Number(parts[5]) : undefined
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      (hasView && (!Number.isSafeInteger(viewNumber) || (viewNumber ?? 0) < 1))
    ) {
      return null
    }
    return {
      kind: parts[0] === 'orgs' ? 'org' : 'user',
      owner: parts[1],
      number,
      host: url.host.toLowerCase(),
      ...(viewNumber !== undefined ? { viewNumber } : {})
    }
  } catch {
    // Shorthand parsing remains available for non-URL input.
  }
  const shorthand = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/)
  if (!shorthand) {
    return null
  }
  const number = Number.parseInt(shorthand[2], 10)
  if (!Number.isInteger(number) || number < 1) {
    return null
  }
  return { kind: 'bare', owner: shorthand[1], number }
}

async function resolveOwnerType(
  owner: string,
  preferred: GitHubProjectOwnerType | null,
  host?: string
): Promise<
  | { ok: true; ownerType: GitHubProjectOwnerType; title: string }
  | { ok: false; error: GitHubProjectViewError }
> {
  const tryOne = async (
    ownerType: GitHubProjectOwnerType,
    number: number | null
  ): Promise<{ ok: true; title: string } | { ok: false; error: GitHubProjectViewError }> => {
    const root = ownerQueryRoot(ownerType)
    const query = number
      ? `
        query($owner:String!, $num:Int!) {
          ${root}(login:$owner) { projectV2(number:$num) { id title } }
        }
      `
      : `
        query($owner:String!) {
          ${root}(login:$owner) { login }
        }
      `
    const vars: GraphqlVars = { owner }
    if (number) {
      vars.num = number
    }
    const result = await runGraphql<
      Record<string, { projectV2?: { id?: string; title?: string } | null; login?: string } | null>
    >(query, vars, projectGhExecOptions(host))
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
    const top = result.data[root]
    if (!top) {
      return { ok: false, error: { type: 'not_found', message: 'Owner not found.' } }
    }
    if (number) {
      const project = top.projectV2
      if (!project || typeof project.id !== 'string') {
        return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
      }
      return { ok: true, title: project.title ?? '' }
    }
    return { ok: true, title: '' }
  }

  const cached = getCachedOwnerType(owner, host)
  const candidates: GitHubProjectOwnerType[] = preferred
    ? [preferred]
    : cached
      ? [cached]
      : ['organization', 'user']
  const fallback: GitHubProjectOwnerType[] = preferred
    ? []
    : cached
      ? cached === 'organization'
        ? ['user']
        : ['organization']
      : []
  let lastError: GitHubProjectViewError | null = null
  for (const ownerType of [...candidates, ...fallback]) {
    const result = await tryOne(ownerType, null)
    if (result.ok) {
      rememberOwnerType(owner, ownerType, host)
      return { ok: true, ownerType, title: result.title }
    }
    lastError = result.error
    if (result.error.type !== 'not_found') {
      return { ok: false, error: result.error }
    }
  }
  rememberOwnerType(owner, null, host)
  return {
    ok: false,
    error: lastError ?? { type: 'not_found', message: 'Owner not found.' }
  }
}

export async function resolveProjectRef(
  args: ResolveProjectRefArgs
): Promise<ResolveProjectRefResult> {
  const input = typeof args.input === 'string' ? args.input.trim() : ''
  if (!input) {
    return { ok: false, error: { type: 'validation_error', message: 'Input required.' } }
  }
  if (isGitHubProjectRefInputTooLarge(input)) {
    return {
      ok: false,
      error: { type: 'validation_error', message: GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR }
    }
  }
  const parsed = parseProjectPaste(input, args.host)
  if (!parsed) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Could not parse input. Expected a GitHub project URL or `owner/number`.'
      }
    }
  }
  const preferred: GitHubProjectOwnerType | null =
    parsed.kind === 'org' ? 'organization' : parsed.kind === 'user' ? 'user' : null
  // A pasted URL is authoritative; the ambient host only applies to shorthand.
  const executionHost = parsed.kind === 'bare' ? githubProjectHost(args.host) : parsed.host
  const ownerResult = await resolveOwnerType(parsed.owner, preferred, executionHost)
  if (!ownerResult.ok) {
    return { ok: false, error: ownerResult.error }
  }
  const root = ownerQueryRoot(ownerResult.ownerType)
  const query = `
    query($owner:String!, $num:Int!) {
      ${root}(login:$owner) { projectV2(number:$num) { id title } }
    }
  `
  const result = await runGraphql<
    Record<string, { projectV2?: { id?: string; title?: string } | null } | null>
  >(query, { owner: parsed.owner, num: parsed.number }, projectGhExecOptions(executionHost))
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  const project = result.data[root]?.projectV2
  if (!project || typeof project.id !== 'string') {
    return { ok: false, error: { type: 'not_found', message: 'Project not found.' } }
  }
  return {
    ok: true,
    owner: parsed.owner,
    ownerType: ownerResult.ownerType,
    number: parsed.number,
    title: project.title ?? '',
    host: executionHost,
    ...(parsed.kind !== 'bare' && parsed.viewNumber !== undefined
      ? { viewNumber: parsed.viewNumber }
      : {})
  }
}

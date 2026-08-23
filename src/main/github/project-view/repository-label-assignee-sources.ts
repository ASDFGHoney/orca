import { ghExecFileAsync } from '../../git/github-cli-runner'
import {
  acquire,
  extractExecError,
  noteRepositoryRateLimitSpend,
  projectGhExecOptions,
  projectHostAuthenticationError,
  release,
  repositoryRateLimitGuard,
  validateSlugArgs
} from './internals'
import { classifyProjectError, rateLimitedError } from './project-error-classification'
import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import type {
  ListAssignableUsersBySlugResult,
  ListLabelsBySlugResult
} from '../../../shared/github/project-result-types'
import type {
  ListAssignableUsersBySlugArgs,
  ListLabelsBySlugArgs
} from '../../../shared/github/project-request-types'

export async function listLabelsBySlug(
  args: ListLabelsBySlugArgs
): Promise<ListLabelsBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {
    return v
  }
  const authError = await projectHostAuthenticationError(args.host)
  if (authError) {
    return { ok: false, error: authError }
  }
  const guard = repositoryRateLimitGuard(args, 'core')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard) }
  }
  await acquire()
  // Why: `--paginate` may fan out to multiple pages; we can only reasonably
  // estimate a 1-call spend up front. The next probe will reconcile.
  noteRepositoryRateLimitSpend(args, 'core')
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', '--paginate', `repos/${args.owner}/${args.repo}/labels`, '--jq', '.[].name'],
      { encoding: 'utf-8', ...projectGhExecOptions(args.host) }
    )
    return {
      ok: true,
      labels: stdout
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
    }
  } catch (err) {
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, maybeStdout, args.host) }
  } finally {
    release()
  }
}

export async function listAssignableUsersBySlug(
  args: ListAssignableUsersBySlugArgs
): Promise<ListAssignableUsersBySlugResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {
    return v
  }
  const authError = await projectHostAuthenticationError(args.host)
  if (authError) {
    return { ok: false, error: authError }
  }
  // Seed logins merge after the fetch so callers can include currently-visible
  // assignees even if the repo participant search is sparse.
  const result: GitHubAssignableUser[] = []
  const guard = repositoryRateLimitGuard(args, 'core')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard) }
  }
  await acquire()
  noteRepositoryRateLimitSpend(args, 'core')
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--paginate',
        `repos/${args.owner}/${args.repo}/assignees`,
        '--jq',
        '.[] | {login: .login, name: null, avatarUrl: .avatar_url}'
      ],
      { encoding: 'utf-8', ...projectGhExecOptions(args.host) }
    )
    for (const line of stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)) {
      try {
        const u = JSON.parse(line) as { login?: string; avatarUrl?: string; name?: string | null }
        if (typeof u.login === 'string') {
          result.push({ login: u.login, name: u.name ?? null, avatarUrl: u.avatarUrl ?? '' })
        }
      } catch {
        // skip malformed jq line
      }
    }
  } catch (err) {
    const { stderr } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, '', args.host) }
  } finally {
    release()
  }
  if (args.seedLogins) {
    const seen = new Set(result.map((u) => u.login))
    for (const login of args.seedLogins) {
      if (typeof login === 'string' && !seen.has(login)) {
        result.push({ login, name: null, avatarUrl: '' })
        seen.add(login)
      }
    }
  }
  return { ok: true, users: result }
}

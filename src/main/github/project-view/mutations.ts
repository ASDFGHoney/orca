import { ghExecFileAsync } from '../../git/github-cli-runner'
import {
  acquire,
  assertPositiveInt,
  extractExecError,
  noteRepositoryRateLimitSpend,
  projectHostAuthenticationError,
  release,
  repositoryRateLimitGuard,
  runRest,
  validateSlugArgs
} from './internals'
import { classifyProjectError, rateLimitedError } from './project-error-classification'
import { githubProjectHost } from '../../../shared/github/project-identity'
import type { GitHubProjectMutationResult } from '../../../shared/github/project-result-types'
import type { UpdateIssueBySlugArgs } from '../../../shared/github/project-request-types'

function githubHostExecOptions(args: { host?: string }): { host: string } {
  return { host: githubProjectHost(args.host) }
}

export async function updateIssueBySlug(
  args: UpdateIssueBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const v = validateSlugArgs(args.owner, args.repo)
  if (!v.ok) {
    return v
  }
  const n = assertPositiveInt(args.number, 'number')
  if (!n.ok) {
    return { ok: false, error: n.error }
  }
  if (!args.updates || typeof args.updates !== 'object') {
    return { ok: false, error: { type: 'validation_error', message: 'Updates required.' } }
  }
  const {
    title,
    body,
    state,
    stateReason,
    duplicateOf,
    addLabels,
    removeLabels,
    addAssignees,
    removeAssignees
  } = args.updates

  if (duplicateOf !== undefined && (state !== 'closed' || stateReason !== 'duplicate')) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Duplicate target is only valid when closing as duplicate.'
      }
    }
  }
  if (state === 'closed' && stateReason === 'duplicate' && duplicateOf === undefined) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Duplicate target issue number is required.'
      }
    }
  }
  if (duplicateOf !== undefined) {
    const duplicate = assertPositiveInt(duplicateOf, 'duplicateOf')
    if (!duplicate.ok) {
      return { ok: false, error: duplicate.error }
    }
  }
  const authError = await projectHostAuthenticationError(args.host)
  if (authError) {
    return { ok: false, error: authError }
  }

  // Title/body go through PATCH /repos/{owner}/{repo}/issues/{n}.
  // State uses gh issue close/reopen so duplicate closes can record a target.
  // Labels/assignees go through their dedicated endpoints.
  const base = `repos/${args.owner}/${args.repo}/issues/${args.number}`

  if (state !== undefined) {
    const guard = repositoryRateLimitGuard(args, 'core')
    if (guard.blocked) {
      return { ok: false, error: rateLimitedError(guard) }
    }
    const stateArgs =
      state === 'closed'
        ? ['issue', 'close', String(args.number), '--repo', `${args.owner}/${args.repo}`]
        : ['issue', 'reopen', String(args.number), '--repo', `${args.owner}/${args.repo}`]
    if (state === 'closed') {
      if (stateReason === 'completed') {
        stateArgs.push('--reason', 'completed')
      } else if (stateReason === 'not_planned') {
        stateArgs.push('--reason', 'not planned')
      } else if (stateReason === 'duplicate') {
        stateArgs.push('--duplicate-of', String(duplicateOf))
      }
    }
    await acquire()
    noteRepositoryRateLimitSpend(args, 'core')
    try {
      await ghExecFileAsync(stateArgs, { encoding: 'utf-8', ...githubHostExecOptions(args) })
    } catch (err) {
      const { stderr, stdout } = extractExecError(err)
      return { ok: false, error: classifyProjectError(stderr, stdout, args.host) }
    } finally {
      release()
    }
  }

  // 1) PATCH body
  if (title !== undefined || body !== undefined) {
    const patchArgs: string[] = ['-X', 'PATCH', base]
    if (title !== undefined) {
      patchArgs.push('--raw-field', `title=${title}`)
    }
    if (body !== undefined) {
      patchArgs.push('--raw-field', `body=${body}`)
    }
    const r = await runRest<unknown>(patchArgs, undefined, 'core', githubHostExecOptions(args))
    if (!r.ok) {
      return { ok: false, error: r.error }
    }
  }

  // 2) Labels — collapse multi-delete fan-out into a single PUT when removing
  //    >1 label. PUT /labels replaces the entire label set, so we fetch the
  //    current labels first and compute the resulting set client-side. This
  //    turns an N-delete + 1-add (=N+1 calls) into 1-fetch + 1-PUT (=2 calls)
  //    once removeLabels has more than one entry, capping the cost at 2 even
  //    for a "remove all 20 labels" mutation.
  const removeCount = removeLabels?.length ?? 0
  const addCount = addLabels?.length ?? 0
  if (removeCount > 1) {
    type RawLabelResp = { name?: string }[]
    const fetched = await runRest<RawLabelResp>(
      ['-X', 'GET', `${base}/labels`],
      undefined,
      'core',
      githubHostExecOptions(args)
    )
    if (!fetched.ok) {
      return { ok: false, error: fetched.error }
    }
    const currentNames = new Set(
      fetched.data.map((l) => l.name).filter((n): n is string => typeof n === 'string')
    )
    for (const l of removeLabels ?? []) {
      currentNames.delete(l)
    }
    for (const l of addLabels ?? []) {
      currentNames.add(l)
    }
    if (currentNames.size === 0) {
      // Why: `gh api -X PUT` with no `--raw-field` arguments sends an empty
      // body — GitHub does NOT interpret that as "clear labels". The
      // dedicated DELETE endpoint is the documented way to remove all
      // labels in a single call.
      const r = await runRest<unknown>(['-X', 'DELETE', `${base}/labels`], undefined, 'core', {
        expectEmpty: true,
        ...githubHostExecOptions(args)
      })
      if (!r.ok && r.error.type !== 'not_found') {
        return { ok: false, error: r.error }
      }
    } else {
      const putArgs = ['-X', 'PUT', `${base}/labels`]
      for (const name of currentNames) {
        putArgs.push('--raw-field', `labels[]=${name}`)
      }
      const r = await runRest<unknown>(putArgs, undefined, 'core', githubHostExecOptions(args))
      if (!r.ok) {
        return { ok: false, error: r.error }
      }
    }
  } else {
    if (addCount > 0) {
      const restArgs = ['-X', 'POST', `${base}/labels`]
      for (const l of addLabels ?? []) {
        restArgs.push('--raw-field', `labels[]=${l}`)
      }
      const r = await runRest<unknown>(restArgs, undefined, 'core', githubHostExecOptions(args))
      if (!r.ok) {
        return { ok: false, error: r.error }
      }
    }
    if (removeCount === 1) {
      const r = await runRest<unknown>(
        ['-X', 'DELETE', `${base}/labels/${encodeURIComponent(removeLabels![0])}`],
        undefined,
        'core',
        { expectEmpty: true, ...githubHostExecOptions(args) }
      )
      if (!r.ok && r.error.type !== 'not_found') {
        return { ok: false, error: r.error }
      }
    }
  }

  // 3) Assignees — POST and DELETE both accept arrays in a single call, so
  //    add/remove are at most 2 calls regardless of array size.
  if (addAssignees && addAssignees.length > 0) {
    const restArgs = ['-X', 'POST', `${base}/assignees`]
    for (const u of addAssignees) {
      restArgs.push('--raw-field', `assignees[]=${u}`)
    }
    const r = await runRest<unknown>(restArgs, undefined, 'core', githubHostExecOptions(args))
    if (!r.ok) {
      return { ok: false, error: r.error }
    }
  }
  if (removeAssignees && removeAssignees.length > 0) {
    const restArgs = ['-X', 'DELETE', `${base}/assignees`]
    for (const u of removeAssignees) {
      restArgs.push('--raw-field', `assignees[]=${u}`)
    }
    const r = await runRest<unknown>(restArgs, undefined, 'core', githubHostExecOptions(args))
    if (!r.ok) {
      return { ok: false, error: r.error }
    }
  }
  return { ok: true }
}

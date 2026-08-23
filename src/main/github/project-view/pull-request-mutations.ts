import { assertPositiveInt, projectGhExecOptions, runRest, validateSlugArgs } from './internals'
import type { GitHubProjectMutationResult } from '../../../shared/github/project-result-types'
import type { UpdatePullRequestBySlugArgs } from '../../../shared/github/project-request-types'

export async function updatePullRequestBySlug(
  args: UpdatePullRequestBySlugArgs
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
  const patchArgs: string[] = [
    '-X',
    'PATCH',
    `repos/${args.owner}/${args.repo}/pulls/${args.number}`
  ]
  // Why: count fields explicitly rather than inferring from patchArgs.length —
  // adding a future header/flag arg silently breaks an array-length check.
  let fieldCount = 0
  if (args.updates.title !== undefined) {
    patchArgs.push('--raw-field', `title=${args.updates.title}`)
    fieldCount++
  }
  if (args.updates.body !== undefined) {
    patchArgs.push('--raw-field', `body=${args.updates.body}`)
    fieldCount++
  }
  if (args.updates.state !== undefined) {
    patchArgs.push('--raw-field', `state=${args.updates.state}`)
    fieldCount++
  }
  if (fieldCount === 0) {
    // No fields to update — nothing to do.
    return { ok: true }
  }
  const r = await runRest<unknown>(patchArgs, undefined, 'core', projectGhExecOptions(args.host))
  if (!r.ok) {
    return { ok: false, error: r.error }
  }
  return { ok: true }
}

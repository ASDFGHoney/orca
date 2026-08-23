import { projectGhExecOptions, runGraphql, type GraphqlVars } from './internals'
import type { GitHubProjectFieldMutationValue } from '../../../shared/github/project-types'
import type { GitHubProjectMutationResult } from '../../../shared/github/project-result-types'
import type {
  ClearProjectItemFieldArgs,
  UpdateProjectItemFieldArgs
} from '../../../shared/github/project-request-types'

class UnknownFieldMutationKindError extends Error {
  constructor(kind: string) {
    super(`Unknown project field mutation kind: ${kind}`)
  }
}

function graphqlValueForFieldMutation(value: GitHubProjectFieldMutationValue): string {
  // Serialize the value fragment for the GraphQL mutation. We use GraphQL
  // variables for every dynamic piece, so here we only pick the variable name
  // to reference per value kind.
  switch (value.kind) {
    case 'single-select':
      return 'singleSelectOptionId: $value'
    case 'iteration':
      return 'iterationId: $value'
    case 'text':
      return 'text: $value'
    case 'number':
      return 'number: $value'
    case 'date':
      return 'date: $value'
  }
  // Why: keep a runtime guard for malformed IPC payloads while lint enforces
  // that every typed mutation kind is handled above.
  throw new UnknownFieldMutationKindError((value as { kind: string }).kind)
}

function mutationValueVar(value: GitHubProjectFieldMutationValue): {
  type: string
  val: string | number
} {
  switch (value.kind) {
    case 'single-select':
      return { type: 'String!', val: value.optionId }
    case 'iteration':
      return { type: 'String!', val: value.iterationId }
    case 'text':
      return { type: 'String!', val: value.text }
    case 'number':
      return { type: 'Float!', val: value.number }
    case 'date':
      return { type: 'Date!', val: value.date }
  }
  // Why: see graphqlValueForFieldMutation — surface unknown kinds loudly
  // instead of returning undefined and dispatching an invalid mutation.
  throw new UnknownFieldMutationKindError((value as { kind: string }).kind)
}

export async function updateProjectItemFieldValue(
  args: UpdateProjectItemFieldArgs
): Promise<GitHubProjectMutationResult> {
  if (!args.projectId || !args.itemId || !args.fieldId) {
    return { ok: false, error: { type: 'validation_error', message: 'Missing ids.' } }
  }
  let valFrag: string
  let valVar: { type: string; val: string | number }
  try {
    valFrag = graphqlValueForFieldMutation(args.value)
    valVar = mutationValueVar(args.value)
  } catch (err) {
    if (err instanceof UnknownFieldMutationKindError) {
      return { ok: false, error: { type: 'validation_error', message: err.message } }
    }
    throw err
  }
  const query = `
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $value:${valVar.type}) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { ${valFrag} }
      }) { projectV2Item { id } }
    }
  `
  const vars: GraphqlVars = {
    projectId: args.projectId,
    itemId: args.itemId,
    fieldId: args.fieldId,
    value: valVar.val
  }
  const res = await runGraphql<unknown>(query, vars, projectGhExecOptions(args.host))
  if (!res.ok) {
    return { ok: false, error: res.error }
  }
  return { ok: true }
}

export async function clearProjectItemFieldValue(
  args: ClearProjectItemFieldArgs
): Promise<GitHubProjectMutationResult> {
  if (!args.projectId || !args.itemId || !args.fieldId) {
    return { ok: false, error: { type: 'validation_error', message: 'Missing ids.' } }
  }
  const query = `
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
      }) { projectV2Item { id } }
    }
  `
  const res = await runGraphql<unknown>(
    query,
    {
      projectId: args.projectId,
      itemId: args.itemId,
      fieldId: args.fieldId
    },
    projectGhExecOptions(args.host)
  )
  if (!res.ok) {
    return { ok: false, error: res.error }
  }
  return { ok: true }
}

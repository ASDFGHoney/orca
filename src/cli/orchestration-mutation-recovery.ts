import { RuntimeClientError } from './runtime-client'

export function orchestrationMutationRecoveryError(error: unknown): unknown {
  if (!(error instanceof RuntimeClientError) || !isUnknownMutationOutcomeCode(error.code)) {
    return error
  }
  const data = objectRecord(error.data)
  const requestId = data?.orchestrationRequestId
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return error
  }
  const dispatchId = typeof data?.dispatchId === 'string' ? data.dispatchId : undefined
  const originalCommand = commandParts(data?.originalCommand)
  const retryCommand = originalCommand
    ? [...originalCommand, '--retry-request', requestId]
    : undefined
  const queryCommand = dispatchId
    ? ['orca', 'orchestration', 'worker-show', '--dispatch', dispatchId, '--json']
    : undefined
  const recovery = {
    orchestrationRequestId: requestId,
    ...(dispatchId ? { dispatchId } : {}),
    ...(queryCommand ? { queryCommand } : {}),
    ...(retryCommand ? { retryCommand } : {}),
    recoveryBlocked: !retryCommand,
    disposition: 'outcome_unknown',
    workerDeathInferred: false
  }
  const retryStep = retryCommand
    ? `Then re-issue the exact original command with --retry-request ${requestId}.`
    : `Recovery is blocked until the exact original command is available; if it is, re-issue it with --retry-request ${requestId}.`
  const nextSteps = queryCommand
    ? [`Run ${queryCommand.join(' ')} before retrying.`, retryStep]
    : [retryStep]
  const message = [
    stripUnsafeRetryAdvice(error.message, requestId),
    'The orchestration mutation may already have taken effect; do not assume it failed.',
    ...nextSteps,
    typeof data?.failedStage === 'string' ? `Failed stage: ${data.failedStage}.` : undefined,
    Array.isArray(data?.residualResources)
      ? `Residual resources: ${JSON.stringify(data.residualResources)}.`
      : undefined
  ].filter((line): line is string => line !== undefined)
  return new RuntimeClientError(error.code, message.join('\n'), {
    ...data,
    orchestrationRequestId: requestId,
    recovery,
    nextSteps
  })
}

function isUnknownMutationOutcomeCode(code: string): boolean {
  return [
    'runtime_unavailable',
    'remote_runtime_unavailable',
    'runtime_timeout',
    'invalid_runtime_response'
  ].includes(code)
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function commandParts(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return [...value]
  }
  if (typeof value === 'string' && value.length > 0) {
    return value.trim().split(/\s+/)
  }
  return undefined
}

function stripUnsafeRetryAdvice(message: string, requestId: string): string {
  return message
    .replace(' Restart Orca and try again.', '')
    .replace(' Retry the command.', '')
    .replace(` Orchestration mutation request ID: ${requestId}.`, '')
}

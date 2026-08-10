import type { ClaudeControlRequest } from './claude-stream-json-connection'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export function handleClaudeInboundControl(input: {
  sessionId: string
  attempt: ClaudeAcquisitionAttempt
  request: ClaudeControlRequest
  emit: (event: ClaudeStructuredSessionEvent) => void
}): void {
  const connection = input.attempt.connection
  if (input.request.request.subtype === 'request_user_dialog') {
    void connection?.respond(input.request.request_id, { behavior: 'cancelled' }).catch(() => {})
    return
  }
  const prompt = input.attempt.prompts.register(input.request)
  if (!prompt) {
    void connection
      ?.respondWithError(
        input.request.request_id,
        `Orca does not handle ${input.request.request.subtype}`
      )
      .catch(() => {})
    return
  }
  input.emit({ type: 'prompt', sessionId: input.sessionId, prompt })
}

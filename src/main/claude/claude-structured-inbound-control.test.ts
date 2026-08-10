import { describe, expect, it, vi } from 'vitest'
import { createClaudeAcquisitionAttempt } from './claude-structured-session-state'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { handleClaudeInboundControl } from './claude-structured-inbound-control'

function rejectingAttempt() {
  const attempt = createClaudeAcquisitionAttempt(new ClaudePromptRegistry())
  const respond = vi.fn().mockRejectedValue(new Error('connection closed'))
  const respondWithError = vi.fn().mockRejectedValue(new Error('connection closed'))
  attempt.connection = { respond, respondWithError } as never
  return { attempt, respond, respondWithError }
}

describe('Claude inbound control', () => {
  it('consumes rejected writes while declining unsupported controls', async () => {
    const dialog = rejectingAttempt()
    handleClaudeInboundControl({
      sessionId: 'session-1',
      attempt: dialog.attempt,
      request: {
        type: 'control_request',
        request_id: 'dialog-1',
        request: { subtype: 'request_user_dialog' }
      },
      emit: vi.fn()
    })
    const unsupported = rejectingAttempt()
    handleClaudeInboundControl({
      sessionId: 'session-1',
      attempt: unsupported.attempt,
      request: {
        type: 'control_request',
        request_id: 'control-1',
        request: { subtype: 'future_control' }
      },
      emit: vi.fn()
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(dialog.respond).toHaveBeenCalledWith('dialog-1', { behavior: 'cancelled' })
    expect(unsupported.respondWithError).toHaveBeenCalledWith(
      'control-1',
      'Orca does not handle future_control'
    )
  })
})

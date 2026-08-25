import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'

export function settleClaudeDispatchWaiters(session: ClaudeSession): void {
  for (const waiter of session.dispatchWaiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.resolve(null)
  }
}

export function settleClaudeExitedSession(session: ClaudeSession): void {
  settleClaudeDispatchWaiters(session)
  session.prompts.clear()
  session.translator?.dispose()
}

export async function closeClaudePublishedSession(input: {
  sessions: Map<string, ClaudeSession>
  sessionId: string
  persistHandle?: (handle: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
}): Promise<boolean> {
  const session = input.sessions.get(input.sessionId)
  if (!session) {
    return true
  }
  // Keep the live session intact when its durable handoff handle cannot be saved.
  await input.persistHandle?.({
    sessionId: input.sessionId,
    providerSessionId: session.providerSessionId,
    leafUuid: session.leafUuid,
    fence: session.fence
  })
  const exited = await session.connection.close()
  if (exited === false) {
    return false
  }
  input.sessions.delete(input.sessionId)
  settleClaudeDispatchWaiters(session)
  session.prompts.clear()
  input.onEvent?.({
    type: 'handle',
    sessionId: input.sessionId,
    providerSessionId: session.providerSessionId,
    leafUuid: session.leafUuid,
    fence: session.fence
  })
  const ended = {
    type: 'ended',
    sessionId: input.sessionId,
    reason: 'claude session closed'
  } as const
  session.translator?.handle(ended)
  input.onEvent?.(ended)
  session.translator?.dispose()
  return true
}

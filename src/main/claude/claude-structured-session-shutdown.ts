import { closeClaudePublishedSession } from './claude-structured-session-close'
import {
  cancelClaudeAcquisitionAttempt,
  closeClaudeSessionsUntilStopped,
  type ClaudeAcquisitionRegistry,
  type ClaudeSession,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export async function closeClaudeSession(input: {
  sessionId: string
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  deps?: Pick<ClaudeStructuredSessionAdapterDeps, 'persistHandle' | 'onEvent'>
}): Promise<boolean> {
  if (!(await cancelClaudeAcquisitionAttempt(input.acquisitions.get(input.sessionId)))) {
    return false
  }
  return closeClaudePublishedSession({
    sessions: input.sessions,
    sessionId: input.sessionId,
    ...(input.deps?.persistHandle ? { persistHandle: input.deps.persistHandle } : {}),
    ...(input.deps?.onEvent ? { onEvent: input.deps.onEvent } : {})
  })
}

export function closePublishedClaudeSession(input: {
  sessionId: string
  sessions: Map<string, ClaudeSession>
  persistHandle?: (handle: {
    sessionId: string
    providerSessionId: string
    leafUuid: string | null
    fence: number
  }) => Promise<void>
  onEvent?: (event: ClaudeStructuredSessionEvent) => void
}): Promise<boolean> {
  return closeClaudePublishedSession(input)
}

export async function closeAllClaudeSessions(input: {
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  close: (sessionId: string) => Promise<boolean>
}): Promise<void> {
  input.acquisitions.close()
  await closeClaudeSessionsUntilStopped(
    () => input.sessions.size > 0 || input.acquisitions.size > 0,
    () => new Set([...input.sessions.keys(), ...input.acquisitions.sessionIds()]),
    input.close
  )
}

import { extname } from 'node:path'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../shared/agent-session-resume'
import { parseExecutionHostId } from '../../shared/execution-host'

export type NativeChatTranscriptOwner =
  | { kind: 'legacy-local' }
  | { kind: 'local'; providerSession: AgentProviderSessionMetadata }
  | {
      kind: 'ssh'
      connectionId: string
      providerSession: AgentProviderSessionMetadata
      transcriptPath: string | null
    }
  | { kind: 'unknown' }

export function resolveNativeChatTranscriptOwner(args: {
  sessionId: string
  providerSession?: AgentProviderSessionMetadata
}): NativeChatTranscriptOwner {
  if (args.providerSession === undefined) {
    return { kind: 'legacy-local' }
  }
  const providerSession = normalizeAgentProviderSession(args.providerSession)
  if (!providerSession || providerSession.id !== args.sessionId) {
    return { kind: 'unknown' }
  }
  const host = parseExecutionHostId(providerSession.executionHostId)
  if (host?.kind === 'local') {
    return { kind: 'local', providerSession }
  }
  if (host?.kind === 'ssh') {
    const transcriptPath = providerSession.transcriptPath?.trim()
    return {
      kind: 'ssh',
      connectionId: host.targetId,
      providerSession,
      transcriptPath: transcriptPath && extname(transcriptPath) === '.jsonl' ? transcriptPath : null
    }
  }
  return { kind: 'unknown' }
}

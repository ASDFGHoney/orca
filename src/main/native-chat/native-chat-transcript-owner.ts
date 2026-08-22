import { extname } from 'node:path'
import type { AgentType } from '../../shared/native-chat-types'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { agentHookServer } from '../agent-hooks/server'

export type NativeChatTranscriptOwner =
  | { kind: 'legacy-local' }
  | { kind: 'local'; transcriptPath?: string }
  | { kind: 'ssh'; connectionId: string; transcriptPath: string | null }
  | { kind: 'unknown' }

type NativeChatOwnerArgs = {
  agent?: AgentType
  sessionId: string
  paneKey?: string
  transcriptPath?: string
}

function exactTranscriptPath(value: string | undefined): string | undefined {
  const transcriptPath = value?.trim()
  return transcriptPath && extname(transcriptPath) === '.jsonl' ? transcriptPath : undefined
}

export function resolveNativeChatTranscriptOwner(
  args: NativeChatOwnerArgs
): NativeChatTranscriptOwner {
  const sessionId = args.sessionId.trim()
  if (!sessionId) {
    return { kind: 'unknown' }
  }
  const rows = args.paneKey
    ? agentHookServer.getStatusSnapshotForPane(args.paneKey)
    : agentHookServer.getStatusSnapshot()
  const matches = rows.filter(
    (row) =>
      row.providerSession?.id === sessionId &&
      (!args.agent || !row.agentType || row.agentType === args.agent)
  )
  if (matches.length === 0) {
    return args.paneKey ? { kind: 'unknown' } : { kind: 'legacy-local' }
  }
  const owners = new Map<string, (typeof matches)[number]>()
  for (const row of matches) {
    const connectionId = row.connectionId ?? null
    const transcriptPath = exactTranscriptPath(row.providerSession?.transcriptPath) ?? null
    owners.set(`${connectionId ?? 'local'}\0${transcriptPath ?? ''}`, row)
  }
  if (owners.size !== 1) {
    return { kind: 'unknown' }
  }
  const row = owners.values().next().value
  if (!row) {
    return { kind: 'unknown' }
  }
  const transcriptPath = exactTranscriptPath(row.providerSession?.transcriptPath)
  const connectionId = row.connectionId?.trim()
  if (!connectionId || isWslHookRelayConnectionId(connectionId)) {
    return { kind: 'local', ...(transcriptPath ? { transcriptPath } : {}) }
  }
  return { kind: 'ssh', connectionId, transcriptPath: transcriptPath ?? null }
}

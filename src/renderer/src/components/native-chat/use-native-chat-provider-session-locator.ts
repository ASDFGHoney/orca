import { useMemo } from 'react'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'

export function useNativeChatProviderSessionLocator(
  providerSession: AgentProviderSessionMetadata | null | undefined
): AgentProviderSessionMetadata | null {
  const key = providerSession?.key
  const id = providerSession?.id
  const transcriptPath = providerSession?.transcriptPath
  const executionHostId = providerSession?.executionHostId
  return useMemo(
    () =>
      key && id
        ? {
            key,
            id,
            ...(transcriptPath ? { transcriptPath } : {}),
            ...(executionHostId ? { executionHostId } : {})
          }
        : null,
    [executionHostId, id, key, transcriptPath]
  )
}

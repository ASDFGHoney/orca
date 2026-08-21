import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { UseNativeChatLiveSessionArgs } from './native-chat-live-session-types'

export function nativeChatLiveSourceKey(
  args: UseNativeChatLiveSessionArgs,
  providerSession: AgentProviderSessionMetadata | null
): string {
  return JSON.stringify([
    args.paneKey,
    args.runtimeEnvironmentId ?? null,
    args.agent,
    args.sessionId,
    args.transcriptPath ?? null,
    providerSession?.executionHostId ?? null
  ])
}

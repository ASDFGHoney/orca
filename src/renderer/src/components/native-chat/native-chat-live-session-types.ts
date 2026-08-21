import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatSession
} from '../../../../shared/native-chat-types'

export type UseNativeChatLiveSessionArgs = {
  paneKey: string
  agent: AgentType
  sessionId: string | null
  transcriptPath?: string | null
  providerSession?: AgentProviderSessionMetadata | null
  runtimeEnvironmentId?: string | null
  enabled?: boolean
}

export type ReadState =
  | { phase: 'loading' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

export type NativeChatLiveSession = NativeChatSession & {
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => void
  readPhase: ReadState['phase']
}

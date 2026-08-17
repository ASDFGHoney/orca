import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutbox(outbox, submissions)
  // The WAL row publishes before the provider accepts, so a live outbox entry
  // can coexist with its canonical submission item; the optimistic bubble wins
  // until acceptance removes it.
  const optimisticItemIds = new Set(
    optimistic.map((entry) => agentJournalSubmissionKey(entry.clientMessageId))
  )
  return [
    ...projectStructuredItemsToNativeChat(
      items.filter((item) => !optimisticItemIds.has(item.itemId))
    ),
    ...optimistic.map(
      (entry): NativeChatMessage => ({
        id: entry.clientMessageId,
        role: 'user',
        source: 'transcript',
        timestamp: entry.queuedAt,
        blocks: entry.body.blocks
      })
    )
  ]
}

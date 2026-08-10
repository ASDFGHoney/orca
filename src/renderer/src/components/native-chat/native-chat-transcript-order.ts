import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/** Renderer-local ordering for authoritative live transcript appends. */
export type NativeChatTranscriptOrder = {
  generation: number
  highWater: number
  messageSequenceById: ReadonlyMap<string, number>
}

export function createNativeChatTranscriptOrder(generation = 0): NativeChatTranscriptOrder {
  return { generation, highWater: 0, messageSequenceById: new Map() }
}

export function replaceNativeChatTranscriptOrder(
  previous: NativeChatTranscriptOrder
): NativeChatTranscriptOrder {
  return createNativeChatTranscriptOrder(previous.generation + 1)
}

export function appendNativeChatTranscriptOrder(
  previous: NativeChatTranscriptOrder,
  incoming: readonly NativeChatMessage[],
  retainedCount: number
): NativeChatTranscriptOrder {
  if (incoming.length === 0) {
    return previous
  }
  let highWater = previous.highWater
  // The map is hook-owned; mutating it avoids copying the whole transcript
  // window on every streaming frame while the wrapper identity still advances.
  const nextById = previous.messageSequenceById as Map<string, number>
  for (const message of incoming) {
    if (!nextById.has(message.id)) {
      highWater += 1
      nextById.set(message.id, highWater)
    }
  }
  while (nextById.size > retainedCount) {
    const oldestId = nextById.keys().next().value
    if (oldestId === undefined) {
      break
    }
    nextById.delete(oldestId)
  }
  return { generation: previous.generation, highWater, messageSequenceById: nextById }
}

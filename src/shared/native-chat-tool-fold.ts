import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from './native-chat-types'

function isToolOnlyMessage(message: NativeChatMessage): boolean {
  return (
    message.blocks.length > 0 &&
    message.blocks.every((block) => isToolCallBlock(block) || isToolResultBlock(block))
  )
}

/** A tool result carries no call id, so it can only be attributed to a tool call
 *  that is loaded alongside it. A windowed transcript read starts wherever the
 *  window falls — often between an assistant's `tool_use` and the result that
 *  answers it — and Claude re-emits already-answered result records at a
 *  `/compact` boundary, long after their call scrolled out. Either way the
 *  result renders as a bare, unowned block that reads as a message from nowhere,
 *  so drop it here; it comes back attached once the owning turn pages in. */
function dropUnattributableToolResults(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const output: NativeChatMessage[] = []
  let unansweredCalls = 0
  for (const message of messages) {
    const blocks: NativeChatBlock[] = []
    for (const block of message.blocks) {
      if (isToolCallBlock(block)) {
        unansweredCalls += 1
      } else if (isToolResultBlock(block)) {
        if (unansweredCalls === 0) {
          continue
        }
        unansweredCalls -= 1
      }
      blocks.push(block)
    }
    if (blocks.length === message.blocks.length) {
      output.push(message)
    } else if (blocks.length > 0) {
      output.push({ ...message, blocks })
    }
  }
  return output
}

/** Fold consecutive tool-only messages into their preceding assistant turn,
 *  after dropping results no loaded call can own. */
export function foldToolMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  const output: NativeChatMessage[] = []
  let mutableAssistantIndex = -1
  for (const message of dropUnattributableToolResults(messages)) {
    const previous = output.at(-1)
    if (isToolOnlyMessage(message) && previous?.role === 'assistant') {
      const index = output.length - 1
      if (mutableAssistantIndex !== index) {
        output[index] = { ...previous, blocks: [...previous.blocks] }
        mutableAssistantIndex = index
      }
      output[index]!.blocks.push(...message.blocks)
    } else {
      output.push(message)
      mutableAssistantIndex = -1
    }
  }
  return output
}

export type NativeChatToolPair = {
  call?: NativeChatToolCallBlock
  result?: NativeChatToolResultBlock
}

/** Pair calls and results by FIFO ordinal because transcript blocks carry no tool ids. */
export function pairToolBlocks(
  blocks: readonly NativeChatBlock[],
  limit = Infinity
): NativeChatToolPair[] {
  const pairs: NativeChatToolPair[] = []
  const callSlots: (number | null)[] = []
  let resultOrdinal = 0
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      if (pairs.length < limit) {
        callSlots.push(pairs.length)
        pairs.push({ call: block })
      } else {
        callSlots.push(null)
      }
      continue
    }
    if (block.type !== 'tool-result') {
      continue
    }
    const slot = callSlots[resultOrdinal]
    if (slot === undefined) {
      if (pairs.length < limit) {
        pairs.push({ result: block })
      }
    } else {
      resultOrdinal += 1
      if (slot !== null) {
        pairs[slot]!.result = block
      }
    }
  }
  return pairs
}

export function splitNativeChatBlocks(blocks: readonly NativeChatBlock[]): {
  prose: NativeChatBlock[]
  tools: NativeChatBlock[]
} {
  const prose: NativeChatBlock[] = []
  const tools: NativeChatBlock[] = []
  for (const block of blocks) {
    if (isToolCallBlock(block) || isToolResultBlock(block)) {
      tools.push(block)
    } else {
      prose.push(block)
    }
  }
  return { prose, tools }
}

import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from './ansi-escape-sequences'
import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from './native-chat-types'

/** Take the send path's transport bytes back out of the user's own turns.
 *
 *  Why: a chat send reaches the agent over the PTY, so the Ctrl+U that clears the
 *  input line is recorded as part of the prompt (captured JSONL rows read
 *  `\x15<body>`). `normalizeNativeChatUserText` already drops those bytes for
 *  MATCHING; this drops them for DISPLAY, so the bubble shows — and Copy, which
 *  reads the same blocks, yields — exactly what was typed rather than invisible
 *  terminal machinery. Doing both from the same strip keeps what we match on and
 *  what we render in agreement.
 *
 *  Scoped to user turns on purpose: tool results carry real escape sequences that
 *  belong to the program that emitted them and are not ours to rewrite. Returns
 *  the input array untouched when nothing changed, so the render memo holds. */
export function stripControlBytesFromUserTurns(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  let next: NativeChatMessage[] | null = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    const blocks = message.role === 'user' ? strippedTextBlocks(message.blocks) : message.blocks
    if (blocks === message.blocks) {
      next?.push(message)
      continue
    }
    next ??= messages.slice(0, index)
    next.push({ ...message, blocks })
  }
  return next ?? (messages as NativeChatMessage[])
}

function strippedTextBlocks(blocks: readonly NativeChatBlock[]): NativeChatBlock[] {
  let next: NativeChatBlock[] | null = null
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    if (!isTextBlock(block)) {
      next?.push(block)
      continue
    }
    // Escape sequences first: stripping ESC as a lone control byte would strand
    // the printable tail of a bracketed-paste marker.
    const text = stripAnsiEscapeSequences(block.text).replace(
      TERMINAL_CONTROL_CHARACTER_PATTERN,
      ''
    )
    if (text === block.text) {
      next?.push(block)
      continue
    }
    next ??= blocks.slice(0, index)
    next.push({ ...block, text })
  }
  return next ?? (blocks as NativeChatBlock[])
}

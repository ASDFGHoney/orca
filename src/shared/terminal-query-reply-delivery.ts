import type { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import {
  extractOnlyTerminalQueryReplies,
  needsCookedEchoSafeQueryReply
} from './terminal-query-reply'

/**
 * True when `delivery` has taken ownership of the WHOLE payload.
 *
 * All-or-nothing on purpose, and decided BEFORE any reply is written: a mid-payload
 * decision would either duplicate the constituents already written or drop the rest,
 * and taking a payload that needs no ordering at all would skip the caller's own
 * queues. The daemon's post-ready flush
 * gate is the one that matters: a CPR written past it lands ahead of the buffered
 * startup command and the shell executes the spliced remainder instead of the command.
 */
export function deliverTerminalQueryReplyPayload(
  data: string,
  delivery: Pick<PtyStartupReplyDelivery, 'answer' | 'answerInOrder' | 'hasDeferredWrites'>
): boolean {
  const replies = extractOnlyTerminalQueryReplies(data)
  if (!replies) {
    return false
  }
  // Nothing here needs echo containment and nothing is deferred, so there is nothing to
  // order behind: leave it on the caller's path.
  if (!delivery.hasDeferredWrites && !replies.some(needsCookedEchoSafeQueryReply)) {
    return false
  }
  // Why `any` and not `all`: returning false after an earlier constituent was already
  // written would have the caller re-write the whole payload and duplicate it into the
  // child's stdin, which corrupts a parser mid-read. Returning false only when NOTHING
  // was written is what makes the caller's fallback safe.
  //
  // The residual case is a mixed payload where one constituent fails (the pty closed
  // mid-loop) and another succeeded: that one is dropped, because nothing can un-write
  // its predecessors. Its `onFailed` still fires. Not reachable while the pty is alive —
  // both entry points only refuse once closed or once a write has thrown.
  let accepted = false
  for (const reply of replies) {
    const handled = needsCookedEchoSafeQueryReply(reply)
      ? delivery.answer(reply)
      : delivery.answerInOrder(reply)
    accepted = handled || accepted
  }
  return accepted
}

import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countImageSourceTurnsAfter,
  normalizeReconcileText,
  normalizedUserText
} from './mobile-native-chat-draft-reconcile'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

const SPACE = ' '
const NO_PENDING_IDS: ReadonlySet<string> = new Set()
// Slack the cursor slide may spend re-trying later start positions, on top of
// one free pass over the run. Nothing bounds how many sends accumulate on the
// agent's input line — that ends when the agent accepts input again — so the
// budget must never truncate a genuine glue: the first attempt covers the whole
// run and always fits. It only stops a run of identical prefix-matching sends
// from making the scan quadratic.
export const GLUE_SLIDE_BUDGET = 8

type UserTurn = { index: number; text: string }
type GlueSegment = { text: string; tail: number } | null

/** Pending ids represented by post-send transcript rows that glued adjacent sends. */
export function selectGluedPendingIds(
  messages: readonly NativeChatMessage[],
  pending: readonly MobileNativeChatPendingMessage[],
  excludedPendingIds: ReadonlySet<string> = NO_PENDING_IDS
): ReadonlySet<string> {
  const retired = new Set<string>()
  if (pending.length < 2) {
    return retired
  }
  const messageIndexById = new Map<string, number>()
  const turns: UserTurn[] = []
  for (const [index, message] of messages.entries()) {
    messageIndexById.set(message.id, index)
    const text = normalizedUserText(message)
    if (text) {
      turns.push({ index, text })
    }
  }
  const segments: GlueSegment[] = pending.map((item) => {
    const text = normalizeReconcileText(item.text)
    const tail =
      item.baselineTailMessageId === null
        ? -1
        : (messageIndexById.get(item.baselineTailMessageId) ?? null)
    return excludedPendingIds.has(item.id) ||
      !item.baselineResolved ||
      item.images?.length ||
      text === '' ||
      tail === null
      ? null
      : { text, tail }
  })

  // Barriers preserve original adjacency after exact landings retire.
  let runStart = 0
  while (runStart < pending.length) {
    while (runStart < pending.length && segments[runStart] === null) {
      runStart += 1
    }
    let runEnd = runStart
    while (runEnd < pending.length && segments[runEnd] !== null) {
      runEnd += 1
    }
    let cursor = runStart
    for (const turn of turns) {
      if (cursor >= runEnd - 1) {
        break
      }
      // A send that can never match must not freeze the run behind it. One
      // permanently unretirable head — a pair whose own glued row arrived with
      // the read, or a send the count pass claimed against an older row — would
      // otherwise disable glue retirement for every later pair, for the rest of
      // the session. Slide past it; the cursor stays monotonic, so a later turn
      // can never claim a send an earlier one already took.
      let budget = runEnd - runStart + GLUE_SLIDE_BUDGET
      let start = cursor
      let matched = 0
      for (; start <= runEnd - 2 && budget > 0; start++) {
        const attempt = matchGluedRun(turn, segments, start, runEnd)
        budget -= attempt.inspected
        matched = attempt.matched
        if (matched > 0) {
          break
        }
      }
      if (matched === 0) {
        continue
      }
      for (let index = start; index < start + matched; index++) {
        retired.add(pending[index]!.id)
      }
      cursor = start + matched
    }
    runStart = runEnd + 1
  }
  return retired
}

/** Length of the exact glued run at `start`, plus the segments it had to read. */
function matchGluedRun(
  turn: UserTurn,
  segments: readonly GlueSegment[],
  start: number,
  end: number
): { matched: number; inspected: number } {
  let at = 0
  let matched = 0
  let inspected = 0
  for (let index = start; index < end; index++) {
    const segment = segments[index]!
    inspected += 1
    // Every send carries its OWN boundary: a row that already existed when this
    // send was issued can never be part of its echo, however well it reads.
    if (turn.index <= segment.tail) {
      return { matched: 0, inspected }
    }
    if (at > 0 && turn.text[at] === SPACE) {
      at += 1
    }
    if (!turn.text.startsWith(segment.text, at)) {
      return { matched: 0, inspected }
    }
    at += segment.text.length
    matched += 1
    if (at === turn.text.length) {
      // A lone exact match is an ordinary landing, which the count pass owns.
      return { matched: matched > 1 ? matched : 0, inspected }
    }
  }
  return { matched: 0, inspected }
}

/** Retires exact and glued transcript landings while preserving pending order. */
export function retireLandedMobileNativeChatPending(
  messages: readonly NativeChatMessage[],
  current: MobileNativeChatPendingMessage[],
  landedImagePendingIds: ReadonlySet<string>
): MobileNativeChatPendingMessage[] {
  const landedCounts = new Map<string, number>()
  for (const message of messages) {
    const text = normalizedUserText(message)
    if (text) {
      landedCounts.set(text, (landedCounts.get(text) ?? 0) + 1)
    }
  }
  const landedPendingIds = new Set<string>()
  for (const item of current) {
    if (landedImagePendingIds.has(item.id)) {
      landedPendingIds.add(item.id)
      continue
    }
    // Keep image echoes until their local preview reaches the authoritative message.
    // An unresolved baseline has nothing to count against yet — `messages` is not
    // known to be the transcript this send was issued into.
    if (item.images?.length || !item.baselineResolved) {
      continue
    }
    // Normalized, not `trim()`: a send is caption-less only once control bytes
    // are off it too, which is how the baseline pass classifies the same item.
    const text = normalizeReconcileText(item.text)
    const landed =
      text === ''
        ? countImageSourceTurnsAfter(messages, item.baselineTailMessageId) >=
          item.expectedOccurrence
        : (landedCounts.get(text) ?? 0) >= item.expectedOccurrence
    if (landed) {
      landedPendingIds.add(item.id)
    }
  }
  const glued = selectGluedPendingIds(messages, current, landedPendingIds)
  const stranded = selectStrandedPendingIds(current, landedPendingIds, glued)
  return landedPendingIds.size === 0 && glued.size === 0 && stranded.size === 0
    ? current
    : current.filter(
        (item) => !landedPendingIds.has(item.id) && !glued.has(item.id) && !stranded.has(item.id)
      )
}

/** Pending ids the queue has drained past, which therefore can never land.
 *
 * Why: Claude Code takes a mid-turn send off its queue through a
 * `queued_command` attachment and writes no user record for it at all, so that
 * send has no row to match — ever. Pending renders at the tail, so the echo then
 * replays below every turn that follows and the conversation reads as re-ordered.
 *
 * The evidence is drainage, not a timer: an echo is stranded only once every send
 * issued after it has been accounted for. While any later send is still
 * outstanding the queue has not caught up, and this one's row may yet arrive —
 * including the glue case, where a later send deliberately stays pending because
 * a barrier blocked its run. That keeps the rule from ever dropping a send whose
 * row is merely slow. A trailing unlandable send waits for the next send, and
 * until then it is still the newest bubble, so it is not yet out of order.
 */
function selectStrandedPendingIds(
  pending: readonly MobileNativeChatPendingMessage[],
  landed: ReadonlySet<string>,
  glued: ReadonlySet<string>
): ReadonlySet<string> {
  const stranded = new Set<string>()
  let accountedAfter = true
  let hasLater = false
  for (let index = pending.length - 1; index >= 0; index--) {
    const item = pending[index]!
    if (!landed.has(item.id) && !glued.has(item.id)) {
      // An unresolved baseline was captured against a transcript not known to be
      // this session's, so drainage around it proves nothing about it.
      if (accountedAfter && hasLater && item.baselineResolved) {
        stranded.add(item.id)
      } else {
        accountedAfter = false
      }
    }
    hasLater = true
  }
  return stranded.size === 0 ? NO_PENDING_IDS : stranded
}

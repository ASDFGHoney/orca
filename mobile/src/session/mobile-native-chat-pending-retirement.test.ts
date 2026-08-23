import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'
import {
  GLUE_SLIDE_BUDGET,
  retireLandedMobileNativeChatPending,
  selectGluedPendingIds
} from './mobile-native-chat-pending-retirement'

const NO_IMAGE_ECHOES: ReadonlySet<string> = new Set()

function userTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

function assistantTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

/** A send captured with `tail` as the last transcript message it could see. */
function pendingSend(
  id: string,
  text: string,
  tail: string | null,
  expectedOccurrence = 1,
  baselineResolved = true
): MobileNativeChatPendingMessage {
  return { id, text, expectedOccurrence, baselineTailMessageId: tail, baselineResolved }
}

function retiredIds(
  messages: readonly NativeChatMessage[],
  pending: readonly MobileNativeChatPendingMessage[]
): string[] {
  return [...selectGluedPendingIds(messages, pending)].sort()
}

describe('selectGluedPendingIds', () => {
  it('retires both bubbles when two rapid sends collapse into one user row', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the tests again', 5000)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('retires a glued row that concatenated with no separator at all', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the testsagain', 5000)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('retires three collapsed prompts in one row', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two three', 5000)]
    const pending = [
      pendingSend('p1', 'one', 'm1'),
      pendingSend('p2', 'two', 'm1'),
      pendingSend('p3', 'three', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2', 'p3'])
  })

  it('matches across tab, newline and repeated-space separators', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the tests\t\n  again', 5000)
    ]
    const pending = [
      pendingSend('p1', ' run the tests\n', 'm1'),
      pendingSend('p2', '\tagain ', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('matches prompts that themselves contain the separator', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'fix the bug and run the tests', 5000)
    ]
    const pending = [
      pendingSend('p1', 'fix the bug', 'm1'),
      pendingSend('p2', 'and run the tests', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('matches when one pending is a strict prefix of the next', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'run run the tests', 5000)]
    const pending = [pendingSend('p1', 'run', 'm1'), pendingSend('p2', 'run the tests', 'm1')]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  it('matches identical prompts sent twice and three times', () => {
    const twice = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'hi hi', 5000)]
    expect(
      retiredIds(twice, [pendingSend('p1', 'hi', 'm1', 1), pendingSend('p2', 'hi', 'm1', 2)])
    ).toEqual(['p1', 'p2'])

    const thrice = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'hi hi hi', 5000)]
    expect(
      retiredIds(thrice, [
        pendingSend('p1', 'hi', 'm1', 1),
        pendingSend('p2', 'hi', 'm1', 2),
        pendingSend('p3', 'hi', 'm1', 3)
      ])
    ).toEqual(['p1', 'p2', 'p3'])
  })

  it('retires two separate glued rows against their own runs', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'one two', 5000),
      userTurn('m3', 'three four', 6000)
    ]
    const pending = [
      pendingSend('p1', 'one', 'm1'),
      pendingSend('p2', 'two', 'm1'),
      pendingSend('p3', 'three', 'm2'),
      pendingSend('p4', 'four', 'm2')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  // FP1: the concatenation already exists in history, older than the sends.
  it('never lets a transcript row that predates the sends retire them', () => {
    const messages = [
      userTurn('m1', 'run the tests again', 1),
      assistantTurn('m2', 'done', 2),
      assistantTurn('m3', 'anything else?', 3)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm3'), pendingSend('p2', 'again', 'm3')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  // FP2: an old turn reads like the concatenation of two much later sends.
  it('never lets an older turn retire sends captured after it', () => {
    const messages = [userTurn('m1', 'fix the bug', 1000), assistantTurn('m2', 'fixed', 1100)]
    const pending = [pendingSend('p1', 'fix the', 'm2'), pendingSend('p2', 'bug', 'm2')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('rejects a row the pending run only prefixes', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'run the tests again with coverage', 5000)
    ]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('rejects a run that only partly spells the row', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'run the tests', 5000)]
    const pending = [pendingSend('p1', 'run the tests', 'm1'), pendingSend('p2', 'again', 'm1')]
    // A lone exact match is an ordinary landing, not glue.
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('rejects glue when a send in the run cannot resolve its own tail', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [pendingSend('p1', 'one', 'm1'), pendingSend('p2', 'two', 'paginated-away')]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  it('treats a null tail as "transcript was empty", so any row can glue', () => {
    const messages = [userTurn('m1', 'one two', 5000)]
    const pending = [pendingSend('p1', 'one', null), pendingSend('p2', 'two', null)]
    expect(retiredIds(messages, pending)).toEqual(['p1', 'p2'])
  })

  // Unresolved baselines are held out of matching until the drafts hook rebases
  // them onto the first authoritative read — see mobile-native-chat-pending-baseline.
  it('holds out sends whose baseline has not been rebased onto a real transcript', () => {
    const messages = [userTurn('m1', 'one two', 1000)]
    const pending = [
      pendingSend('p1', 'one', null, 1, false),
      pendingSend('p2', 'two', null, 1, false)
    ]
    expect(retiredIds(messages, pending)).toEqual([])
  })

  // A head that can never match must not freeze the run behind it: one stuck
  // bubble would otherwise disable glue retirement for the rest of the session.
  it('glues a later pair even when the head of the run can never match', () => {
    const messages = [
      userTurn('m0', 'unrelated', 1000),
      userTurn('m1', 'fix the bug', 5000),
      userTurn('m2', 'ship the fix', 6000)
    ]
    const stuckHead = pendingSend('p0', 'bug', 'm0')
    const pair = [pendingSend('p1', 'ship the', 'm0'), pendingSend('p2', 'fix', 'm0')]
    expect(retiredIds(messages, [stuckHead, ...pair])).toEqual(['p1', 'p2'])
  })

  // Nothing bounds how many sends pile onto the agent's input line, so the
  // slide's budget must never truncate a genuine glue.
  it('retires a glued run far longer than the slide budget', () => {
    const words = Array.from({ length: 12 }, (_, index) => `w${index}`)
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', words.join(' '), 5000)]
    const pending = words.map((word, index) => pendingSend(`p${index}`, word, 'm1'))
    expect(retiredIds(messages, pending)).toHaveLength(words.length)
  })

  it('skips a caption-less image echo instead of gluing it', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [
      pendingSend('p1', '', 'm1'),
      pendingSend('p2', 'one', 'm1'),
      pendingSend('p3', 'two', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual(['p2', 'p3'])
  })

  it('keeps a captioned image echo and its neighbors until the preview is rebound', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    const pending = [
      { ...pendingSend('p1', 'one', 'm1'), images: ['file:///a.png'] },
      pendingSend('p2', 'two', 'm1')
    ]
    expect(retiredIds(messages, pending)).toEqual([])
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((item) => item.id)
    ).toEqual(['p1', 'p2'])
  })

  it('does nothing for a single pending send', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'one two', 5000)]
    expect(retiredIds(messages, [pendingSend('p1', 'one', 'm1')])).toEqual([])
  })

  // The cursor slides past a head that cannot match, so a turn may try several
  // start positions — but one inspection budget covers the whole slide, keeping
  // the work linear in the run length rather than quadratic. The attempt already
  // in flight is allowed to overshoot the remaining budget, deliberately: that is
  // what guarantees a genuine long glue is never truncated.
  it('keeps segment inspection linear in the run length per transcript turn', () => {
    const pendingCount = 96
    const turnCount = 12
    const text = `${'a '.repeat(pendingCount)}x`
    const messages = [
      assistantTurn('tail', 'ready', 1000),
      ...Array.from({ length: turnCount }, (_, index) => userTurn(`m${index}`, text, 2000 + index))
    ]
    const pending = Array.from({ length: pendingCount }, (_, index) =>
      pendingSend(`p${index}`, 'a', 'tail', index + 1)
    )
    const startsWith = vi.spyOn(String.prototype, 'startsWith')
    let segmentChecks = 0
    try {
      expect(retiredIds(messages, pending)).toEqual([])
      segmentChecks = startsWith.mock.calls.length
    } finally {
      startsWith.mockRestore()
    }
    expect(segmentChecks).toBeLessThanOrEqual(turnCount * (2 * pendingCount + GLUE_SLIDE_BUDGET))
  })
})

describe('retireLandedMobileNativeChatPending', () => {
  it('retires exact landings by ordinal and glued rows in the same pass', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', 'standalone', 4000),
      userTurn('m3', 'run the tests again', 5000)
    ]
    const pending = [
      pendingSend('p0', 'standalone', 'm1'),
      pendingSend('p1', 'run the tests', 'm2'),
      pendingSend('p2', 'again', 'm2')
    ]
    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual([])
  })

  // The drafts effect early-outs on `next === current`; a fresh array on the
  // no-op path would re-enter it on every transcript frame.
  it('returns the input array itself when nothing retires', () => {
    const messages = [assistantTurn('m1', 'ready', 1000)]
    const pending = [pendingSend('p1', 'one', 'm1'), pendingSend('p2', 'two', 'm1')]
    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toBe(pending)
  })

  it('keeps sends whose glue candidate predates them', () => {
    const messages = [userTurn('m1', 'fix the bug', 1000), assistantTurn('m2', 'fixed', 1100)]
    const pending = [pendingSend('p1', 'fix the', 'm2'), pendingSend('p2', 'bug', 'm2')]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((item) => item.id)
    ).toEqual(['p1', 'p2'])
  })

  it('does not glue former neighbors across an exact-landed send', () => {
    const messages = [
      assistantTurn('m0', 'ready', 1000),
      userTurn('m1', 'middle', 2000),
      userTurn('m2', 'one two', 3000)
    ]
    const pending = [
      pendingSend('p1', 'one', 'm0'),
      pendingSend('p2', 'middle', 'm0'),
      pendingSend('p3', 'two', 'm0')
    ]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((item) => item.id)
    ).toEqual(['p1', 'p3'])
  })

  it('keeps image echoes until their preview is rebound', () => {
    const messages = [assistantTurn('m1', 'ready', 1000)]
    const pending = [{ ...pendingSend('p1', 'photo', 'm1'), images: ['file:///a.png'] }]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((item) => item.id)
    ).toEqual(['p1'])
    expect(retireLandedMobileNativeChatPending(messages, pending, new Set(['p1']))).toEqual([])
  })
})

describe('retireLandedMobileNativeChatPending on a PTY-typed send', () => {
  // A TUI may record the leading Ctrl+U transport byte as prompt content.
  const COMPOSER_TEXT = 'run the focused tests\nand summarize failures'
  const TRANSCRIPT_ROW = `\u0015${COMPOSER_TEXT}`

  it('retires the echo of a row the TUI pasted the Ctrl+U byte into', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', TRANSCRIPT_ROW, 5000),
      assistantTurn('m3', 'on it', 6000)
    ]
    const pending = [pendingSend('p1', COMPOSER_TEXT, 'm1')]

    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual([])
  })

  it('still holds the echo when no row carries the text at all', () => {
    const messages = [assistantTurn('m1', 'ready', 1000)]
    const pending = [pendingSend('p1', COMPOSER_TEXT, 'm1')]

    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual(pending)
  })
})

// Remote sends reach the agent TUI with a leading Ctrl+U (kill-input-line) on the
// same write as the body, and Claude Code records it verbatim: live session JSONL
// rows read '\x15If this is an orca bug...'. U+0015 is not whitespace, so trim()
// and /\s/ both leave it in place and the echo never matches its own landing.
const CTRL_U = '\u0015'

describe('retireLandedMobileNativeChatPending - control characters in landed rows', () => {
  it('retires when the echoed send itself carries the control character', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'run the tests', 5000)]
    const pending = [pendingSend('p1', `${CTRL_U}run the tests`, 'm1')]
    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual([])
  })

  it('glues control-character-prefixed sends that collapsed into one row', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', `${CTRL_U}run the tests again`, 5000)
    ]
    const pending = [
      pendingSend('p1', `${CTRL_U}run the tests`, 'm1'),
      pendingSend('p2', `${CTRL_U}again`, 'm1')
    ]
    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual([])
  })

  it('still separates sends that differ only outside the control characters', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', `${CTRL_U}keep this one`, 5000)
    ]
    const pending = [pendingSend('p1', 'a different message', 'm1')]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((i) => i.id)
    ).toEqual(['p1'])
  })
})

// Claude Code consumes a mid-turn send through a `queued_command` attachment and
// logs only `queue-operation` records for it - never a `type:"user"` row (proven
// against the live JSONL: enqueue+remove, no user record). The decoder publishes
// nothing for those records, so the echo has no landing to match, ever.
describe('retireLandedMobileNativeChatPending - sends that can never land', () => {
  it('drops an unlandable send once a later send from the same batch lands', () => {
    const messages = [
      assistantTurn('m1', 'working', 1000),
      userTurn('m2', 'the newest question', 9000)
    ]
    const pending = [
      pendingSend('p1', 'Also if you run out of space on my machine', 'm1'),
      pendingSend('p2', 'the newest question', 'm1')
    ]
    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual([])
  })

  it('keeps every send while none of them has landed yet', () => {
    const messages = [assistantTurn('m1', 'working', 1000)]
    const pending = [
      pendingSend('p1', 'first', 'm1'),
      pendingSend('p2', 'second', 'm1'),
      pendingSend('p3', 'third', 'm1')
    ]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((i) => i.id)
    ).toEqual(['p1', 'p2', 'p3'])
  })

  it('keeps sends issued after the one that landed', () => {
    const messages = [assistantTurn('m1', 'working', 1000), userTurn('m2', 'landed one', 5000)]
    const pending = [
      pendingSend('p1', 'landed one', 'm1'),
      pendingSend('p2', 'still in flight', 'm2')
    ]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((i) => i.id)
    ).toEqual(['p2'])
  })

  it('leaves an unresolved baseline alone - it has nothing to count against yet', () => {
    const messages = [
      assistantTurn('m1', 'working', 1000),
      userTurn('m2', 'the newest question', 9000)
    ]
    const pending = [
      pendingSend('p1', 'never recorded', null, 1, false),
      pendingSend('p2', 'the newest question', 'm1')
    ]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((i) => i.id)
    ).toEqual(['p1'])
  })

  it('reproduces the reported replay: three stale echoes below the newest turn', () => {
    const messages = [
      userTurn('m1', `${CTRL_U}If this is an orca bug please spawn a new worktree`, 1000),
      assistantTurn('m2', 'on it', 2000),
      userTurn('m3', `${CTRL_U}Actually scratch that about deleting worktrees`, 3000),
      assistantTurn('m4', 'understood', 4000),
      userTurn('m5', 'and the newest turn', 9000)
    ]
    const pending = [
      pendingSend('p1', 'If this is an orca bug please spawn a new worktree', null),
      pendingSend('p2', 'Also if you run out of space on my machine', 'm2'),
      pendingSend('p3', 'Actually scratch that about deleting worktrees', 'm2'),
      pendingSend('p4', 'and the newest turn', 'm4')
    ]
    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual([])
  })

  it('drops a whole run of unlandable sends once the queue drains past them', () => {
    const messages = [
      assistantTurn('m1', 'working', 1000),
      userTurn('m2', 'the one that landed', 9000)
    ]
    const pending = [
      pendingSend('p1', 'first mid-turn send', 'm1'),
      pendingSend('p2', 'second mid-turn send', 'm1'),
      pendingSend('p3', 'the one that landed', 'm1')
    ]
    expect(retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES)).toEqual([])
  })

  it('keeps an earlier send while a later one is still outstanding', () => {
    const messages = [assistantTurn('m1', 'working', 1000), userTurn('m2', 'the middle one', 5000)]
    const pending = [
      pendingSend('p1', 'never recorded', 'm1'),
      pendingSend('p2', 'the middle one', 'm1'),
      pendingSend('p3', 'still in flight', 'm1')
    ]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((i) => i.id)
    ).toEqual(['p1', 'p3'])
  })
})

// Drainage speaks only for echoes that reconcile by TEXT. These two reconcile by
// other means (or not at all), and stranding them deletes content rather than
// repositioning it - the bubble is the only place either one is visible.
describe('retireLandedMobileNativeChatPending - drainage leaves non-text echoes alone', () => {
  it('keeps a photo echo when a later send lands', () => {
    const messages = [assistantTurn('m1', 'ready', 1000), userTurn('m2', 'later', 5000)]
    const pending = [
      { ...pendingSend('p1', '', 'm1'), images: ['file:///a.png'] },
      pendingSend('p2', 'later', 'm1')
    ]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((i) => i.id)
    ).toEqual(['p1'])
  })

  it('keeps an echo whose caption is only image markers when a later send lands', () => {
    const messages = [
      assistantTurn('m1', 'ready', 1000),
      userTurn('m2', '[Image #1]', 4000),
      userTurn('m3', 'later', 5000)
    ]
    const pending = [pendingSend('p1', '[Image #1]', 'm1'), pendingSend('p2', 'later', 'm1')]
    expect(
      retireLandedMobileNativeChatPending(messages, pending, NO_IMAGE_ECHOES).map((i) => i.id)
    ).toEqual(['p1'])
  })
})

import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendNativeChatTranscriptOrder,
  createNativeChatTranscriptOrder,
  replaceNativeChatTranscriptOrder
} from './native-chat-transcript-order'

function message(id: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [], timestamp: 1, source: 'transcript' }
}

describe('native chat transcript order', () => {
  it('does not sequence snapshot or pagination baseline rows', () => {
    const initial = createNativeChatTranscriptOrder(3)
    expect(initial).toMatchObject({ generation: 3, highWater: 0 })
    expect(initial.messageSequenceById.size).toBe(0)
  })

  it('sequences appends once and bounds retained ids to the live window', () => {
    const first = appendNativeChatTranscriptOrder(
      createNativeChatTranscriptOrder(3),
      [message('a'), message('b')],
      2
    )
    const next = appendNativeChatTranscriptOrder(first, [message('b'), message('c')], 2)

    expect(next.highWater).toBe(3)
    expect(next.messageSequenceById).toBe(first.messageSequenceById)
    expect([...next.messageSequenceById]).toEqual([
      ['b', 2],
      ['c', 3]
    ])
  })

  it('keeps append-order memory bounded to the retained transcript window', () => {
    let order = createNativeChatTranscriptOrder(3)
    for (let index = 0; index < 1_000; index += 1) {
      order = appendNativeChatTranscriptOrder(order, [message(`m-${index}`)], 8)
    }

    expect(order.highWater).toBe(1_000)
    expect(order.messageSequenceById.size).toBe(8)
  })

  it('resets ordering across an authoritative replacement', () => {
    const appended = appendNativeChatTranscriptOrder(
      createNativeChatTranscriptOrder(3),
      [message('a')],
      1
    )

    expect(replaceNativeChatTranscriptOrder(appended)).toEqual({
      generation: 4,
      highWater: 0,
      messageSequenceById: new Map()
    })
  })
})

// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useNativeChatTranscriptOrder } from './use-native-chat-transcript-order'

describe('useNativeChatTranscriptOrder', () => {
  it('keeps order and updater identity stable across parent re-renders', () => {
    const { result, rerender } = renderHook(() => useNativeChatTranscriptOrder())
    const [firstOrder, firstReplace, firstAppend, firstSettle] = result.current
    const firstMap = firstOrder.messageSequenceById

    rerender()
    rerender()
    rerender()

    const [secondOrder, secondReplace, secondAppend, secondSettle] = result.current
    // Same holder: no fresh createNativeChatTranscriptOrder (order+Map) on re-render.
    expect(secondOrder).toBe(firstOrder)
    expect(secondOrder.messageSequenceById).toBe(firstMap)
    expect(secondReplace).toBe(firstReplace)
    expect(secondAppend).toBe(firstAppend)
    expect(secondSettle).toBe(firstSettle)

    act(() => {
      firstReplace()
    })
    expect(result.current[0]).not.toBe(firstOrder)
    expect(result.current[0].generation).toBe(firstOrder.generation + 1)
    expect(result.current[1]).toBe(firstReplace)
  })
})

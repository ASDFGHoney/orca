import { useCallback, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendNativeChatTranscriptOrder,
  createNativeChatTranscriptOrder,
  replaceNativeChatTranscriptOrder,
  type NativeChatTranscriptOrder
} from './native-chat-transcript-order'

export function useNativeChatTranscriptOrder(): readonly [
  NativeChatTranscriptOrder,
  () => void,
  (messages: readonly NativeChatMessage[], retainedCount: number) => void
] {
  const currentRef = useRef(createNativeChatTranscriptOrder())
  const [current, setCurrent] = useState(currentRef.current)
  const replace = useCallback(() => {
    currentRef.current = replaceNativeChatTranscriptOrder(currentRef.current)
    setCurrent(currentRef.current)
  }, [])
  const append = useCallback((messages: readonly NativeChatMessage[], retainedCount: number) => {
    currentRef.current = appendNativeChatTranscriptOrder(
      currentRef.current,
      messages,
      retainedCount
    )
    setCurrent(currentRef.current)
  }, [])
  return [current, replace, append]
}

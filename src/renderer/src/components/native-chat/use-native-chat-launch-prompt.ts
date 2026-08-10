import { useEffect, useMemo } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useAppStore } from '../../store'
import { launchPromptAsMessage, shouldPruneLaunchPrompt } from './native-chat-launch-prompt'
import type { NativeChatTranscriptOrder } from './native-chat-transcript-order'

export function useNativeChatLaunchPrompt(args: {
  terminalTabId: string
  agent: string
  messages: NativeChatMessage[]
  transcriptOrder: NativeChatTranscriptOrder
  crossClock: boolean
}): { message: NativeChatMessage | null; failed: boolean } {
  const { terminalTabId, agent, messages, transcriptOrder, crossClock } = args
  const launchPrompt = useAppStore(
    (state) => state.nativeChatLaunchPromptByTabId[terminalTabId] ?? null
  )
  const clearLaunchPrompt = useAppStore((state) => state.clearNativeChatLaunchPrompt)
  const paneLaunchPrompt = launchPrompt?.agent === agent ? launchPrompt : null

  useEffect(() => {
    if (
      paneLaunchPrompt &&
      shouldPruneLaunchPrompt(paneLaunchPrompt, messages, {
        crossClock,
        transcriptOrder
      })
    ) {
      clearLaunchPrompt(terminalTabId)
    }
  }, [clearLaunchPrompt, crossClock, messages, paneLaunchPrompt, terminalTabId, transcriptOrder])

  const message = useMemo(
    () =>
      launchPromptAsMessage(paneLaunchPrompt, messages, {
        crossClock,
        transcriptOrder
      }),
    [crossClock, messages, paneLaunchPrompt, transcriptOrder]
  )
  return { message, failed: paneLaunchPrompt?.failed === true }
}

import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import {
  readIncrementalTranscriptMessages,
  type IncrementalTranscriptState
} from './transcript-incremental-reader'
import type { TranscriptRangeFs } from './transcript-range-fs'
import {
  readNativeChatTranscriptTailFile,
  type NativeChatLineDecoder
} from './transcript-tail-reader'
import type { NativeChatTurnLifecycleDecoder } from './transcript-turn-lifecycle'

type TranscriptWatchReadContext = {
  filePath: string
  state: IncrementalTranscriptState
  decode: NativeChatLineDecoder
  decodeLifecycle: NativeChatTurnLifecycleDecoder | null
  signal: AbortSignal
  rangeFs?: TranscriptRangeFs
}

export async function emitTranscriptWatchAppends(
  context: TranscriptWatchReadContext,
  onAppend: (messages: NativeChatMessage[], lifecycle?: NativeChatTurnLifecycle) => void,
  isClosed: () => boolean
): Promise<void> {
  let lifecycle: NativeChatTurnLifecycle | undefined
  const remaining = await readIncrementalTranscriptMessages(
    context.filePath,
    context.state,
    context.decode,
    (messages) => {
      if (!isClosed()) {
        onAppend(messages)
      }
    },
    context.decodeLifecycle ?? undefined,
    (nextLifecycle) => {
      lifecycle = nextLifecycle
    },
    context.signal,
    context.rangeFs
  )
  if (!isClosed() && (remaining.length > 0 || lifecycle)) {
    onAppend(remaining, lifecycle)
  }
}

export function readTranscriptWatchSnapshot(context: TranscriptWatchReadContext, limit: number) {
  return readNativeChatTranscriptTailFile(
    context.filePath,
    limit,
    context.decode,
    false,
    undefined,
    context.decodeLifecycle,
    context.signal,
    context.rangeFs
  )
}

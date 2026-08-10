import { useCallback, useEffect, useMemo, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendCommandMarkerCache,
  clearedMessageIdsForSlashCommand,
  readCommandMarkerCache,
  type NativeChatCommandMarker,
  type NativeChatCommandMarkerScope
} from './native-chat-command-markers'

export function useNativeChatCommandMarkers(args: {
  paneKey: string
  agent: string
  sessionId: string | null
  messages: readonly NativeChatMessage[]
  onWorkingInterruptReset: () => void
}): {
  commandMarkers: NativeChatCommandMarker[]
  onSlashCommand: (command: string) => void
} {
  const { paneKey, agent, sessionId, messages, onWorkingInterruptReset } = args
  const commandMarkerScope = useMemo(
    (): NativeChatCommandMarkerScope => ({ paneKey, agent, sessionId }),
    [paneKey, agent, sessionId]
  )
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  // Command markers are session-scoped because slash commands like /clear are
  // local feedback for a specific transcript boundary.
  useEffect(() => {
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    onWorkingInterruptReset()
  }, [commandMarkerScope, onWorkingInterruptReset])
  const onSlashCommand = useCallback(
    (command: string) => {
      // Why: hide pre-clear rows by id — never renderer sentAt vs host timestamps (#11519).
      setCommandMarkers(
        appendCommandMarkerCache(
          commandMarkerScope,
          command,
          Date.now(),
          clearedMessageIdsForSlashCommand(command, messages)
        )
      )
    },
    [commandMarkerScope, messages]
  )
  return { commandMarkers, onSlashCommand }
}

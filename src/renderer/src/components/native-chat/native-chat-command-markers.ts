// Local slash-command feedback (e.g. `/clear`) for native chat. Commands are not
// transcript turns; markers hide pre-clear rows by message id so we never compare
// renderer sentAt to host/provider timestamps (#11519).

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

export type NativeChatCommandMarker = {
  id: string
  /** The command as typed, e.g. `/clear`. */
  command: string
  sentAt: number
  /** Transcript message ids visible when `/clear` was issued (host-agnostic hide set). */
  clearedMessageIds?: readonly string[]
}

export type NativeChatCommandMarkerScope = {
  paneKey: string
  agent: string
  sessionId: string | null
}

const COMMAND_MARKER_LIMIT = 8
const commandMarkerCache = new Map<string, NativeChatCommandMarker[]>()
let commandMarkerCounter = 0

function commandMarkerScopeKey(scope: NativeChatCommandMarkerScope): string {
  return `${scope.paneKey}\0${scope.agent}\0${scope.sessionId ?? ''}`
}

export function readCommandMarkerCache(
  scope: NativeChatCommandMarkerScope
): NativeChatCommandMarker[] {
  return [...(commandMarkerCache.get(commandMarkerScopeKey(scope)) ?? [])]
}

export function appendCommandMarkerCache(
  scope: NativeChatCommandMarkerScope,
  command: string,
  sentAt = Date.now(),
  clearedMessageIds?: readonly string[]
): NativeChatCommandMarker[] {
  commandMarkerCounter += 1
  const key = commandMarkerScopeKey(scope)
  // Why: native/TUI view switches remount the chat surface, but slash commands
  // are not transcript turns, so their local feedback needs a pane-scoped cache.
  const next = [
    ...(commandMarkerCache.get(key) ?? []),
    {
      id: `${sentAt}-${commandMarkerCounter}`,
      command,
      sentAt,
      ...(clearedMessageIds !== undefined ? { clearedMessageIds: [...clearedMessageIds] } : {})
    }
  ].slice(-COMMAND_MARKER_LIMIT)
  // Why: the per-key array is capped at 8, but the KEY (paneKey\0agent\0sessionId,
  // sessionId changes on every /clear) is ephemeral and was never evicted, so it
  // grew one entry per (pane, session) for the renderer's whole life. LRU-bound
  // the key count (mirrors the #7566 draft/attachment caches in this folder).
  setBoundedScopeCacheEntry(commandMarkerCache, key, next)
  return [...next]
}

export function clearCommandMarkerCacheForTests(): void {
  commandMarkerCache.clear()
  commandMarkerCounter = 0
}

export function isNativeChatClearCommand(command: string): boolean {
  return command.trim().toLowerCase().split(/\s+/)[0] === '/clear'
}

/** Message ids to hide for a `/clear`; undefined for non-clear commands. */
export function clearedMessageIdsForSlashCommand(
  command: string,
  messages: readonly Pick<NativeChatMessage, 'id'>[]
): readonly string[] | undefined {
  if (!isNativeChatClearCommand(command)) {
    return undefined
  }
  return messages.map((message) => message.id)
}

function latestClearMarker(
  markers: readonly NativeChatCommandMarker[]
): NativeChatCommandMarker | null {
  let latest: NativeChatCommandMarker | null = null
  for (const marker of markers) {
    if (
      isNativeChatClearCommand(marker.command) &&
      (latest === null || marker.sentAt > latest.sentAt)
    ) {
      latest = marker
    }
  }
  return latest
}

export function applyCommandMarkerBoundaries(
  messages: readonly NativeChatMessage[],
  markers: readonly NativeChatCommandMarker[]
): NativeChatMessage[] {
  const clearMarker = latestClearMarker(markers)
  if (clearMarker === null) {
    return messages as NativeChatMessage[]
  }
  // Why: `/clear` mutates the TUI/transcript asynchronously. Hide the rows that
  // were visible at clear time by id so we never compare renderer `sentAt` to
  // host/provider `message.timestamp` (cross-clock on remote runtimes).
  if (clearMarker.clearedMessageIds !== undefined) {
    if (clearMarker.clearedMessageIds.length === 0) {
      return messages as NativeChatMessage[]
    }
    const hide = new Set(clearMarker.clearedMessageIds)
    return messages.filter((message) => !hide.has(message.id))
  }
  // Legacy in-memory markers without an id snapshot: keep prior local-clock filter.
  return messages.filter(
    (message) => message.timestamp !== null && message.timestamp > clearMarker.sentAt
  )
}

/** Render command markers as compact `system` messages. The `system` role draws
 *  as a muted aside (not a user bubble); the text avoids the harness noise
 *  prefixes so stripNoiseMessages keeps it. */
export function commandMarkersAsMessages(
  markers: readonly NativeChatCommandMarker[]
): NativeChatMessage[] {
  return markers.map((marker) => ({
    id: `command:${marker.id}`,
    role: 'system' as const,
    blocks: [{ type: 'text' as const, text: `Ran ${marker.command}` }],
    timestamp: marker.sentAt,
    source: 'scrape' as const
  }))
}

/** True when a message id was minted for a slash-command marker. */
export function isCommandMarkerId(id: string): boolean {
  return id.startsWith('command:')
}

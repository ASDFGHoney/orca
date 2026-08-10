import { useEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import {
  applyAppend,
  createNativeChatMerger,
  replaceList
} from '../../../../shared/native-chat-merge'
import {
  applyAppends,
  createIncrementalAssembler,
  reset as resetAssembler,
  sharesNativeChatMessagePrefix
} from './native-chat-incremental-assembler'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import { prepareNativeChatLiveMessages } from './native-chat-live-message-preparation'
import { hasMoreNativeChatHistory, NATIVE_CHAT_INITIAL_LIMIT } from './native-chat-pagination'
import {
  getNativeChatSessionTransport,
  subscribeNativeChatSession
} from './native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import { useNativeChatLoadEarlier } from './use-native-chat-load-earlier'
import { useNativeChatTranscriptOrder } from './use-native-chat-transcript-order'
import {
  assembleNativeChatLiveMessages,
  createNativeChatAuthoritativeSettle,
  isNativeChatSessionIdAdoption,
  NATIVE_CHAT_NOTFOUND_RETRY_WINDOW_MS,
  scheduleNativeChatNotFoundRetry,
  teardownNativeChatSubscription,
  type NativeChatAssemblerCache
} from './native-chat-live-session-order'
import type {
  NativeChatLiveSession,
  ReadState,
  UseNativeChatLiveSessionArgs
} from './native-chat-live-session-types'
export type {
  NativeChatLiveSession,
  ReadState,
  UseNativeChatLiveSessionArgs
} from './native-chat-live-session-types'

// Stable empty-base reference so a non-ready read doesn't churn the base axis.
const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

let subscriptionCounter = 0

/** Windowed readSession + subscribe tail, merged with live hook turn-state. */
export function useNativeChatLiveSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const { paneKey, agent, sessionId, transcriptPath, runtimeEnvironmentId } = args
  // Stable per owner id so a re-render without an owner flip keeps the same transport and doesn't re-subscribe.
  const transport = useMemo(
    () => getNativeChatSessionTransport(runtimeEnvironmentId ?? null),
    [runtimeEnvironmentId]
  )
  const [read, setRead] = useState<ReadState>({ phase: 'loading' })
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [transcriptLifecycle, transcriptLifecycleControl] = useNativeChatTranscriptLifecycle()
  // The active read window; raised by loadEarlier to page in older history.
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)

  // Appended messages accumulate separately from the snapshot so pagination doesn't lose in-flight appends; merged by id and capped to the read window (#6).
  const [appended, setAppended] = useState<NativeChatMessage[]>([])
  const [transcriptOrder, resetTranscriptOrder, appendTranscriptOrder, settleTranscriptOrder] =
    useNativeChatTranscriptOrder()
  // Id-dedup merger backing `appended`; caches the id→index map so each live frame costs O(incoming), not O(existing) (#18).
  const appendMergerRef = useRef(createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY))

  const [hookState, hookStateStartedAt, hookHasWorkingSubagents] = useNativeChatHookStatus(paneKey)

  const latestSessionId = useRef<string | null>(sessionId)
  latestSessionId.current = sessionId
  // Tracks the current transport so a load-earlier resolve from a prior host is discarded after an owner flip (session id can stay the same).
  const latestTransport = useRef(transport)
  latestTransport.current = transport
  const transcriptEpochRef = useRef(0)
  // Why: null→sessionId adoption must keep empty-boundary pending generation
  // (#11509); only hard source flips mint a new order generation.
  const previousOrderSourceRef = useRef({
    agent,
    sessionId,
    transcriptPath: transcriptPath ?? null,
    transport
  })

  // Incremental assembler: suffix-extensions take the fast append path (#17).
  const assemblerCacheRef = useRef<NativeChatAssemblerCache>({
    assembler: createIncrementalAssembler(),
    appliedTranscript: EMPTY_MESSAGES,
    baseSig: null,
    baseMessages: EMPTY_MESSAGES
  })

  useEffect(() => {
    // Why: agent/path/owner rebinds can keep the same session; every source generation must invalidate pagination captured before it.
    transcriptEpochRef.current += 1
    const nextSource = {
      agent,
      sessionId,
      transcriptPath: transcriptPath ?? null,
      transport
    }
    const adoptedSessionId = isNativeChatSessionIdAdoption(
      previousOrderSourceRef.current,
      nextSource
    )
    previousOrderSourceRef.current = nextSource
    // Preserve order across null→sessionId so a first-send pending still matches
    // the mandatory initial snapshot; hard rebinds still replace the generation.
    if (!adoptedSessionId) {
      resetTranscriptOrder()
    }
    const authoritativeSettle = createNativeChatAuthoritativeSettle(
      settleTranscriptOrder,
      () => limitRef.current
    )
    if (adoptedSessionId) {
      authoritativeSettle.markAdoptSettle()
    }
    setLoadingEarlier(false)
    transcriptLifecycleControl.reset()

    let cancelled = false
    // Set by the first authoritative frame so the readSession seed below can't clobber a live snapshot.
    let frameArrived = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: unknown

    if (!sessionId) {
      // No session id yet: surface live hook state on an empty transcript; backfills once the id arrives.
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)
    } else {
      const retryStartedAt = Date.now()
      // Re-bound as a const: TS drops the `!sessionId` narrowing inside the hoisted nested function.
      const activeSessionId = sessionId
      limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
      setRead({ phase: 'loading' })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)

      // Independent initial seed in case subscribe never delivers a snapshot; applied only until an authoritative frame lands so a live snapshot wins.
      function loadSession(attempt: number): void {
        if (frameArrived) {
          return
        }
        void transport
          .readSession(agent, activeSessionId, limitRef.current, transcriptPath ?? undefined)
          .then((result) => {
            if (cancelled || frameArrived) {
              return
            }
            if (result && 'error' in result) {
              // A not-yet-flushed transcript: stay in 'loading' and retry with backoff instead of a permanent error (#8401).
              if (
                result.notFound &&
                Date.now() - retryStartedAt < NATIVE_CHAT_NOTFOUND_RETRY_WINDOW_MS
              ) {
                retryTimer = scheduleNativeChatNotFoundRetry({
                  attempt,
                  onRetry: () => {
                    retryTimer = null
                    loadSession(attempt + 1)
                  }
                })
                return
              }
              setRead({ phase: 'error', error: result.error })
              return
            }
            const messages = result?.messages ?? []
            transcriptLifecycleControl.replace(result?.lifecycle)
            authoritativeSettle.settleFrame(messages, false)
            setRead({ phase: 'ready', messages })
            setHasMore(hasMoreNativeChatHistory(messages.length, limitRef.current))
          })
          .catch((err: unknown) => {
            if (!cancelled && !frameArrived) {
              setRead({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
            }
          })
      }

      loadSession(0)

      subscriptionCounter += 1
      const subscriptionId = `native-chat-${subscriptionCounter}-${Date.now()}`
      unsubscribe = subscribeNativeChatSession(
        transport,
        {
          subscriptionId,
          agent,
          sessionId,
          transcriptPath: transcriptPath ?? undefined,
          limit: limitRef.current
        },
        (frame) => {
          if (!cancelled) {
            if (frame.type === 'snapshot' || frame.type === 'replacement') {
              // Why: snapshots/replacements advance the message list + pagination
              // epoch. Order generation stays put so empty-boundary pending/clear
              // keep matching; only adoption and inode replacements settle rows.
              frameArrived = true
              transcriptEpochRef.current += 1
              setLoadingEarlier(false)
              if ('error' in frame && frame.error) {
                setRead({ phase: 'error', error: frame.error })
                return
              }
              transcriptLifecycleControl.replace(frame.lifecycle)
              replaceList(appendMergerRef.current, frame.messages)
              setAppended([])
              authoritativeSettle.settleFrame(frame.messages, frame.type === 'replacement')
              setRead({ phase: 'ready', messages: appendMergerRef.current.list })
              setHasMore(frame.hasMore)
              return
            }
            transcriptLifecycleControl.append(frame.lifecycle)
            // Merge by id then bound to the window; the base read + assembler re-dedup mean trimming the append tail can't drop a covered turn (#6).
            const retained = applyAppend(appendMergerRef.current, frame.messages, limitRef.current)
            appendTranscriptOrder(frame.messages, retained.length)
            setAppended(retained)
          }
        }
      )
    }

    // Always return a disposer so every allocation path is owned (effect-needs-cleanup).
    return () => {
      cancelled = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (unsubscribe !== undefined) {
        teardownNativeChatSubscription(unsubscribe)
      }
    }
    // `transport` identity changes on an owner flip, re-running this effect to re-subscribe against the new host.
  }, [
    agent,
    sessionId,
    transcriptPath,
    transport,
    transcriptLifecycleControl,
    resetTranscriptOrder,
    appendTranscriptOrder,
    settleTranscriptOrder
  ])

  const loadEarlier = useNativeChatLoadEarlier({
    agent,
    sessionId,
    transcriptPath,
    transport,
    hasMore,
    loadingEarlier,
    readPhase: read.phase,
    transcriptLifecycleControl,
    limitRef,
    transcriptEpochRef,
    latestSessionId,
    latestTransport,
    setLoadingEarlier,
    setRead,
    setHasMore
  })

  // Computed outside the status memo so hookState churn never re-runs the assembler.
  const baseMessages = read.phase === 'ready' ? read.messages : EMPTY_MESSAGES
  const assembledMessages = useMemo(
    () =>
      assembleNativeChatLiveMessages({
        cache: assemblerCacheRef.current,
        baseMessages,
        appended,
        agent,
        sessionId,
        applyAppends,
        resetAssembler,
        sharesPrefix: sharesNativeChatMessagePrefix
      }),
    [baseMessages, appended, sessionId, agent]
  )

  // Keep presentation transforms off the status-only render axis.
  const normalizedMessages = useMemo(
    () => prepareNativeChatLiveMessages(assembledMessages, agent),
    [assembledMessages, agent]
  )

  return useMemo<NativeChatLiveSession>(() => {
    const session = mergeNativeChatLiveSession({
      messages: normalizedMessages,
      sessionId,
      agent,
      hookState,
      stateStartedAt: hookStateStartedAt,
      transcriptLifecycle,
      statusTailMessage: assembledMessages.at(-1),
      hookHasWorkingSubagents,
      // Why: show live watcher-append content over a spinner/stale error (#8401), so overrides apply only when nothing is appended.
      loading: read.phase === 'loading' && appended.length === 0,
      ...(read.phase === 'error' && appended.length === 0 ? { error: read.error } : {})
    })
    return {
      ...session,
      hasMore,
      loadingEarlier,
      loadEarlier,
      readPhase: read.phase,
      transcriptOrder
    }
  }, [
    normalizedMessages,
    assembledMessages,
    read,
    sessionId,
    agent,
    hookState,
    hookStateStartedAt,
    transcriptLifecycle,
    hookHasWorkingSubagents,
    hasMore,
    loadingEarlier,
    loadEarlier,
    appended,
    transcriptOrder
  ])
}

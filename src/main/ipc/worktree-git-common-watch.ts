import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import { isWatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { startGitCommonPolling } from './worktree-git-common-polling'
import { startGitCommonPrimaryPolling } from './worktree-git-common-primary-polling'

// Watches a repo's `<common>/.git/worktrees` metadata plus the primary
// checkout's shallow branch/index files — the only paths the git-common event
// filter consumes.
// macOS: a narrow native stream rooted at `worktrees/` — a tiny, rare-churn
// tree — gives instant detection with zero idle cost and zero wide-scope
// fseventsd delivery; the primary files are covered by a few stat calls per
// tick (a native stream would have to span the whole common dir, objects
// included). Other platforms: dir-listing poll (no fseventsd to protect, and
// on Windows an open directory handle on `worktrees/` could interfere with
// `git worktree prune` removing it).
// The native stream is hosted in the crash-isolated watcher child, never the
// Electron main process: watcher.node teardown races heap-corrupt the hosting
// process when unsubscribe overlaps in-flight callbacks (issue #8732), and
// root deletion via `git worktree prune` makes that overlap routine here.

// The native stream is still the fast path. A scheduled 15-tick reconciliation
// bounds silent watcher loss at the existing 30-second backstop without joining
// the per-repo 2-second timer fleet.
const NARROW_WATCH_RECONCILIATION_TICKS = 15

async function startGitCommonNarrowWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  onWatchError?: (error: Error) => void
): Promise<WorktreeBaseSubscription> {
  const worktreesDir = join(target.path, 'worktrees')
  let disposed = false
  let subscription: WorktreeBaseSubscription | null = null
  let existenceTimer: ReturnType<typeof setInterval> | null = null
  let pollingFallbackPromise: Promise<void> | null = null
  let subscribing = false
  let parkedWhileHidden = false
  let reconciliationSubscription: WorktreeBaseSubscription | null = null
  let usingPollingFallback = false
  let nativeSubscriptionGeneration = 0
  const reconciliationVisibilityListeners = new Set<() => void>()
  const reconciliationVisibility: WorktreePollerWindowVisibility = {
    isWindowVisible: visibility.isWindowVisible,
    onWindowBecameVisible: (listener) => {
      reconciliationVisibilityListeners.add(listener)
      return () => {
        reconciliationVisibilityListeners.delete(listener)
      }
    }
  }

  const stopExistencePoll = (): void => {
    if (existenceTimer) {
      clearInterval(existenceTimer)
      existenceTimer = null
    }
  }

  const shouldUsePollingFallback = (error: unknown): boolean =>
    isWatcherProcessFailure(error) &&
    (error.code === 'supervisor_crash_fuse' || error.code === 'process_unavailable')

  const ensurePollingFallback = (): Promise<void> => {
    if (pollingFallbackPromise) {
      return pollingFallbackPromise
    }
    stopExistencePoll()
    usingPollingFallback = true
    const previousReconciliation = reconciliationSubscription
    reconciliationSubscription = null
    const pending = (
      previousReconciliation
        ? previousReconciliation.unsubscribe().catch(() => {})
        : Promise.resolve()
    )
      .then(() =>
        startGitCommonPolling(
          target.path,
          onEvents,
          pollIntervalMs,
          visibility,
          onFullScan,
          false
        )
      )
      .then(async (fallback) => {
        if (disposed || subscription) {
          await fallback.unsubscribe()
          return
        }
        subscription = fallback
      })
    const tracked = pending.finally(() => {
      if (pollingFallbackPromise === tracked) {
        pollingFallbackPromise = null
      }
    })
    pollingFallbackPromise = tracked
    return pollingFallbackPromise
  }

  // Reconciliation also repairs a stream whose root was deleted and recreated
  // between scans. In that coarse race the signature is present at both samples;
  // a newly listed direct child is the evidence that consumers need a root-create
  // signal and the native subscription needs to be re-armed.
  const ensureReconciliation = async (): Promise<void> => {
    if (disposed || usingPollingFallback || reconciliationSubscription || !subscription) {
      return
    }
    const reconciliation = await startGitCommonPolling(
      target.path,
      (events) => {
        const rootWasReplaced =
          events.some((event) => event.type === 'delete' && event.path === worktreesDir) &&
          events.some((event) => event.type === 'create' && event.path === worktreesDir)
        const coarseRootReplacement = events.some(
          (event) =>
            event.type === 'create' &&
            event.path !== worktreesDir &&
            dirname(event.path) === worktreesDir
        )
        if (rootWasReplaced || coarseRootReplacement) {
          nativeSubscriptionGeneration++
          const current = subscription
          subscription = null
          if (current) {
            void current.unsubscribe().catch(() => {})
          }
          armExistencePoll()
        }
        onEvents(
          coarseRootReplacement
            ? events.map((event) =>
                event.type === 'update' && event.path === worktreesDir
                  ? { ...event, type: 'create' }
                  : event
              )
            : events
        )
      },
      pollIntervalMs * NARROW_WATCH_RECONCILIATION_TICKS,
      reconciliationVisibility,
      undefined,
      false,
      () => [],
      { forceFullScanEveryTick: true }
    )
    if (disposed || usingPollingFallback) {
      await reconciliation.unsubscribe()
    } else {
      reconciliationSubscription = reconciliation
    }
  }

  const tryUpgradeToNarrowWatch = async (): Promise<void> => {
    if (disposed || subscribing || subscription) {
      return
    }
    subscribing = true
    try {
      const installed = await trySubscribe()
      if (installed && !disposed) {
        stopExistencePoll()
        await ensureReconciliation()
        // The dir appearing means a first linked worktree was just
        // registered; surface it so the repo's worktree list refreshes.
        onEvents([{ type: 'create', path: worktreesDir }])
      }
    } finally {
      subscribing = false
    }
  }

  const armExistencePoll = (): void => {
    if (disposed || existenceTimer || subscription) {
      return
    }
    if (!visibility.isWindowVisible()) {
      parkedWhileHidden = true
      return
    }
    existenceTimer = setInterval(() => {
      if (disposed) {
        return
      }
      if (!visibility.isWindowVisible()) {
        parkedWhileHidden = true
        stopExistencePoll()
        return
      }
      void tryUpgradeToNarrowWatch()
    }, pollIntervalMs)
    existenceTimer.unref?.()
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (!disposed && parkedWhileHidden) {
      parkedWhileHidden = false
      void tryUpgradeToNarrowWatch().finally(() => {
        armExistencePoll()
      })
    }
    for (const listener of reconciliationVisibilityListeners) {
      listener()
    }
  })

  const trySubscribe = async (): Promise<boolean> => {
    try {
      const s = await stat(worktreesDir)
      if (!s.isDirectory()) {
        return false
      }
    } catch {
      return false
    }
    const generation = ++nativeSubscriptionGeneration
    let errored = false
    let active = true
    // Why: parcel tears its native stream down when the watched root is
    // deleted (e.g. `git worktree prune` removing an empty worktrees dir) —
    // sometimes surfaced as an error, sometimes as a delete event for the
    // root. Either way: notify, drop the dead stream, and let the existence
    // poll re-arm when a future worktree add recreates the dir.
    const teardown = (): void => {
      active = false
      errored = true
      if (generation === nativeSubscriptionGeneration) {
        nativeSubscriptionGeneration++
      }
      const current = subscription
      subscription = null
      if (current) {
        void current.unsubscribe().catch(() => {})
      }
    }
    const teardownAndRearm = (): void => {
      teardown()
      armExistencePoll()
    }
    try {
      const sub = await subscribeViaWatcherProcess(
        worktreesDir,
        (error, events) => {
          if (
            disposed ||
            !active ||
            generation !== nativeSubscriptionGeneration
          ) {
            return
          }
          if (error) {
            if (onWatchError) {
              onWatchError(error)
            } else {
              onEvents([{ type: 'update', path: worktreesDir }])
            }
            if (shouldUsePollingFallback(error)) {
              teardown()
              void ensurePollingFallback().catch(() => {
                if (!disposed) {
                  armExistencePoll()
                }
              })
            } else {
              teardownAndRearm()
            }
            return
          }
          if (events.length > 0) {
            const rootGone = events.some(
              (event) => event.type === 'delete' && event.path === worktreesDir
            )
            onEvents(events.map((event) => ({ type: event.type, path: event.path })))
            if (rootGone) {
              teardownAndRearm()
            }
          }
        },
        {},
        {
          // Why: a watcher-child crash drops events during the automatic
          // resubscribe gap; report a structural change so worktrees re-sync.
          onInterruption: () => {
            if (
              !disposed &&
              active &&
              generation === nativeSubscriptionGeneration
            ) {
              if (onWatchError) {
                onWatchError(new Error('Git common watcher interrupted'))
              } else {
                onEvents([{ type: 'update', path: worktreesDir }])
              }
            }
          }
        }
      )
      if (generation !== nativeSubscriptionGeneration) {
        void sub.unsubscribe().catch(() => {})
        return false
      }
      if (disposed || errored) {
        void sub.unsubscribe().catch(() => {})
        await pollingFallbackPromise?.catch(() => {})
        return !errored || subscription !== null
      }
      subscription = { unsubscribe: () => sub.unsubscribe() }
      return true
    } catch (error) {
      if (disposed || generation !== nativeSubscriptionGeneration) {
        return false
      }
      if (shouldUsePollingFallback(error)) {
        await ensurePollingFallback()
        return subscription !== null
      }
      return false
    }
  }

  if (!(await trySubscribe())) {
    // Why: repos commonly start without linked worktrees; retrying the narrow
    // subscription lets macOS upgrade to native events when the directory appears.
    armExistencePoll()
  }
  await ensureReconciliation()

  return {
    unsubscribe: async () => {
      disposed = true
      stopExistencePoll()
      unsubscribeVisibility()
      await pollingFallbackPromise?.catch(() => {})
      nativeSubscriptionGeneration++
      const current = subscription
      const reconciliation = reconciliationSubscription
      subscription = null
      reconciliationSubscription = null
      await Promise.all([
        current?.unsubscribe().catch(() => {}),
        reconciliation?.unsubscribe().catch(() => {})
      ])
    }
  }
}

export async function startGitCommonWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  platform: NodeJS.Platform,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  getStatusRefPaths: () => readonly string[] = () => [],
  onWatchError?: (error: Error) => void
): Promise<WorktreeBaseSubscription> {
  if (platform === 'darwin') {
    const [narrowWatch, primaryMetadataPoll] = await Promise.all([
      startGitCommonNarrowWatch(
        target,
        onEvents,
        pollIntervalMs,
        visibility,
        onFullScan,
        onWatchError
      ),
      startGitCommonPrimaryPolling(
        target.path,
        getStatusRefPaths,
        onEvents,
        pollIntervalMs,
        visibility,
        onFullScan
      )
    ])
    return {
      unsubscribe: async () => {
        await Promise.all([narrowWatch.unsubscribe(), primaryMetadataPoll.unsubscribe()])
      }
    }
  }
  return startGitCommonPolling(
    target.path,
    onEvents,
    pollIntervalMs,
    visibility,
    onFullScan,
    true,
    getStatusRefPaths
  )
}

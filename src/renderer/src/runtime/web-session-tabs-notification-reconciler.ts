import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

type SnapshotFreshness = {
  publicationEpoch: string
  snapshotVersion: number
}

export type WebSessionTabsNotificationTrackedWorktree = {
  worktree: string
  freshness: SnapshotFreshness
}

type NotificationWorktreeState = SnapshotFreshness & {
  eligible: boolean
}

export type WebSessionTabsNotificationObservation = {
  seedOnly: boolean
  attentionRequired: boolean
}

export type WebSessionTabsNotificationReconciler = {
  observeSnapshot: (
    snapshot: RuntimeMobileSessionTabsResult,
    options?: { attentionRequired?: boolean }
  ) => void
  observeInventory: (
    snapshots: readonly RuntimeMobileSessionTabsResult[],
    options: { armPublished: boolean; attentionRequired?: boolean }
  ) => void
  armPresentWorktrees: () => void
}

function isRemoval(snapshot: RuntimeMobileSessionTabsResult): boolean {
  return (snapshot as { removed?: unknown }).removed === true
}

function advancesFreshness(
  snapshot: RuntimeMobileSessionTabsResult,
  current: NotificationWorktreeState
): boolean {
  return (
    snapshot.publicationEpoch !== current.publicationEpoch ||
    snapshot.snapshotVersion > current.snapshotVersion
  )
}

export function createWebSessionTabsNotificationReconciler(args: {
  trackedWorktrees: readonly WebSessionTabsNotificationTrackedWorktree[]
  observeAcceptedSnapshot: (
    snapshot: RuntimeMobileSessionTabsResult,
    observation: WebSessionTabsNotificationObservation
  ) => void
}): WebSessionTabsNotificationReconciler {
  const worktrees = new Map<string, NotificationWorktreeState>(
    args.trackedWorktrees.map(({ worktree, freshness }) => [
      worktree,
      { ...freshness, eligible: true }
    ])
  )

  const observeAcceptedSnapshot = (
    snapshot: RuntimeMobileSessionTabsResult,
    attentionRequired: boolean
  ): void => {
    const current = worktrees.get(snapshot.worktree)
    if (isRemoval(snapshot)) {
      worktrees.delete(snapshot.worktree)
      return
    }
    if (current && !advancesFreshness(snapshot, current)) {
      return
    }
    const eligible = current?.eligible === true
    worktrees.set(snapshot.worktree, {
      publicationEpoch: snapshot.publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion,
      eligible
    })
    args.observeAcceptedSnapshot(snapshot, {
      seedOnly: !eligible,
      attentionRequired: eligible && attentionRequired
    })
  }

  return {
    observeSnapshot: (snapshot, options) => {
      observeAcceptedSnapshot(snapshot, options?.attentionRequired === true)
      const state = worktrees.get(snapshot.worktree)
      if (state) {
        state.eligible = true
      }
    },
    observeInventory: (snapshots, options) => {
      const publishedWorktrees = new Set<string>()
      for (const snapshot of snapshots) {
        publishedWorktrees.add(snapshot.worktree)
        observeAcceptedSnapshot(snapshot, options.attentionRequired === true)
      }
      for (const worktree of worktrees.keys()) {
        if (!publishedWorktrees.has(worktree)) {
          worktrees.delete(worktree)
        }
      }
      if (options.armPublished) {
        for (const worktree of publishedWorktrees) {
          const state = worktrees.get(worktree)
          if (state) {
            state.eligible = true
          }
        }
      }
    },
    armPresentWorktrees: () => {
      for (const state of worktrees.values()) {
        state.eligible = true
      }
    }
  }
}

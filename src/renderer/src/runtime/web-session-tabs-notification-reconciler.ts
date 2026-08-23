import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

type SnapshotFreshness = {
  publicationEpoch: string
  snapshotVersion: number
}

export type WebSessionTabsNotificationPaneEvidence = {
  ownerId: number
  worktree: string
  paneIncarnation: number
}

export type WebSessionTabsNotificationTrackedWorktree = {
  worktree: string
  freshness: SnapshotFreshness
}

type NotificationWorktreeState = SnapshotFreshness & {
  eligible: boolean
  paneIncarnations: ReadonlyMap<string, NotificationPaneState>
  resumeAttentionPending: boolean
}

type NotificationPaneState = {
  incarnation: number
  storeCommitted: boolean
}

export type WebSessionTabsNotificationObservation = {
  seedOnly: boolean
  attentionRequired: boolean
  paneEvidenceByKey: ReadonlyMap<string, WebSessionTabsNotificationPaneEvidence>
}

export type WebSessionTabsNotificationReconciler = {
  observeSnapshot: (snapshot: RuntimeMobileSessionTabsResult) => boolean
  observeInventory: (
    snapshots: readonly RuntimeMobileSessionTabsResult[],
    options: { armPublished: boolean }
  ) => void
  armPresentWorktrees: () => void
  beginVisibilityResume: () => void
  endVisibilityResume: () => void
  markSnapshotCommitted: (snapshot: RuntimeMobileSessionTabsResult) => void
  dispose: () => void
}

const worktreesByEvidenceOwner = new Map<number, ReadonlyMap<string, NotificationWorktreeState>>()
let nextEvidenceOwnerId = 0
let nextPaneIncarnation = 0

export function getWebSessionTabsNotificationPaneEvidenceState(
  evidence: WebSessionTabsNotificationPaneEvidence,
  paneKey: string
): 'stale' | 'uncommitted' | 'committed' {
  const pane = worktreesByEvidenceOwner
    .get(evidence.ownerId)
    ?.get(evidence.worktree)
    ?.paneIncarnations.get(paneKey)
  if (!pane || pane.incarnation !== evidence.paneIncarnation) {
    return 'stale'
  }
  return pane.storeCommitted ? 'committed' : 'uncommitted'
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
  acceptsSnapshot?: (snapshot: RuntimeMobileSessionTabsResult) => boolean
  getPaneKeys: (snapshot: RuntimeMobileSessionTabsResult) => readonly string[]
  observeAcceptedSnapshot: (
    snapshot: RuntimeMobileSessionTabsResult,
    observation: WebSessionTabsNotificationObservation
  ) => void
}): WebSessionTabsNotificationReconciler {
  const ownerId = (nextEvidenceOwnerId += 1)
  const worktrees = new Map<string, NotificationWorktreeState>(
    args.trackedWorktrees.map(({ worktree, freshness }) => [
      worktree,
      {
        ...freshness,
        eligible: true,
        paneIncarnations: new Map(),
        resumeAttentionPending: false
      }
    ])
  )
  const observedWorktrees = new Set(worktrees.keys())
  let visibilityResumePending = false
  let futureWorktreesArmed = false
  worktreesByEvidenceOwner.set(ownerId, worktrees)

  const paneIncarnationsForSnapshot = (
    snapshot: RuntimeMobileSessionTabsResult,
    current: NotificationWorktreeState | undefined
  ): ReadonlyMap<string, NotificationPaneState> => {
    const paneIncarnations = new Map<string, NotificationPaneState>()
    for (const paneKey of args.getPaneKeys(snapshot)) {
      const existing = current?.paneIncarnations.get(paneKey)
      paneIncarnations.set(paneKey, {
        incarnation: existing?.incarnation ?? (nextPaneIncarnation += 1),
        storeCommitted: existing?.storeCommitted ?? false
      })
    }
    return paneIncarnations
  }

  const observeAcceptedSnapshot = (snapshot: RuntimeMobileSessionTabsResult): boolean => {
    if (args.acceptsSnapshot?.(snapshot) === false) {
      return false
    }
    const current = worktrees.get(snapshot.worktree)
    const wasObserved = observedWorktrees.has(snapshot.worktree)
    observedWorktrees.add(snapshot.worktree)
    if (isRemoval(snapshot)) {
      worktrees.delete(snapshot.worktree)
      return current !== undefined
    }
    if (current && !advancesFreshness(snapshot, current)) {
      return false
    }
    const eligible = current?.eligible === true
    const newDuringVisibilityResume = !current && visibilityResumePending && !wasObserved
    const paneIncarnations = paneIncarnationsForSnapshot(snapshot, current)
    const state = {
      publicationEpoch: snapshot.publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion,
      eligible,
      paneIncarnations,
      resumeAttentionPending: false
    }
    worktrees.set(snapshot.worktree, state)
    const paneEvidenceByKey = new Map<string, WebSessionTabsNotificationPaneEvidence>()
    for (const [paneKey, pane] of paneIncarnations) {
      paneEvidenceByKey.set(paneKey, {
        ownerId,
        worktree: snapshot.worktree,
        paneIncarnation: pane.incarnation
      })
    }
    args.observeAcceptedSnapshot(snapshot, {
      seedOnly: !eligible && !newDuringVisibilityResume,
      attentionRequired:
        (eligible && current?.resumeAttentionPending === true) || newDuringVisibilityResume,
      paneEvidenceByKey
    })
    return true
  }

  return {
    observeSnapshot: (snapshot) => {
      const accepted = observeAcceptedSnapshot(snapshot)
      const state = worktrees.get(snapshot.worktree)
      if (state) {
        state.eligible = true
      }
      return accepted
    },
    observeInventory: (snapshots, options) => {
      const publishedWorktrees = new Set<string>()
      for (const snapshot of snapshots) {
        if (args.acceptsSnapshot?.(snapshot) === false) {
          continue
        }
        publishedWorktrees.add(snapshot.worktree)
        observeAcceptedSnapshot(snapshot)
      }
      for (const worktree of worktrees.keys()) {
        if (!publishedWorktrees.has(worktree)) {
          worktrees.delete(worktree)
        }
      }
      if (options.armPublished || futureWorktreesArmed) {
        for (const worktree of publishedWorktrees) {
          const state = worktrees.get(worktree)
          if (state) {
            state.eligible = true
          }
        }
      }
      for (const state of worktrees.values()) {
        state.resumeAttentionPending = false
      }
      visibilityResumePending = false
    },
    armPresentWorktrees: () => {
      futureWorktreesArmed = true
      for (const state of worktrees.values()) {
        state.eligible = true
      }
    },
    beginVisibilityResume: () => {
      visibilityResumePending = true
      for (const state of worktrees.values()) {
        state.resumeAttentionPending = true
      }
    },
    endVisibilityResume: () => {
      visibilityResumePending = false
      for (const state of worktrees.values()) {
        state.resumeAttentionPending = false
      }
    },
    markSnapshotCommitted: (snapshot) => {
      const state = worktrees.get(snapshot.worktree)
      if (
        !state ||
        state.publicationEpoch !== snapshot.publicationEpoch ||
        state.snapshotVersion !== snapshot.snapshotVersion
      ) {
        return
      }
      for (const pane of state.paneIncarnations.values()) {
        pane.storeCommitted = true
      }
    },
    dispose: () => {
      worktreesByEvidenceOwner.delete(ownerId)
    }
  }
}

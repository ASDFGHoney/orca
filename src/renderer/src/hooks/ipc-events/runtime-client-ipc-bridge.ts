import { applyHostWorktreeTerminalSleepState } from '@/components/terminal-pane/pty-shutdown-exit-deferral'
import { dispatchTerminalSideEffectBatch } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { applyNativeChatLaunchDraftResolved } from '@/runtime/native-chat-launch-draft-runtime-resolution'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  applyRuntimeEnvironmentSshStateChanged,
  hydrateRuntimeEnvironmentSshState,
  refreshRuntimeEnvironmentSshTargetMetadata
} from '@/runtime/runtime-environment-ssh-state'
import { subscribeRuntimeClientEvents } from '@/runtime/runtime-client-events'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { getEnvironmentSshStateGeneration } from '@/store/slices/runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { useAppStore } from '../../store'
import { createRuntimeClientEventsSync } from '../runtime-client-events-sync'
import {
  createRuntimeProjectRefreshScheduler,
  refreshRuntimeProjectWorktreesAndLineage
} from '../runtime-project-refresh-scheduler'
import {
  buildRuntimeClientEventEnvironmentKey,
  getNewlyDisconnectedRuntimeEnvironmentIds,
  getRuntimeProjectRefreshEnvironmentIds
} from './runtime-environment-subscription-selection'
import type { WorktreeEventRuntime } from './worktree-event-runtime'

function getActiveRuntimeEnvironmentId(): string | null {
  return useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() || null
}
function getRuntimeClientEventEnvironmentIds(): string[] {
  const state = useAppStore.getState()
  const ids = new Set<string>()
  const activeEnvironmentId = getActiveRuntimeEnvironmentId()
  if (activeEnvironmentId) {
    ids.add(activeEnvironmentId)
  }
  for (const environment of state.runtimeEnvironments ?? []) {
    if (state.runtimeStatusByEnvironmentId?.get(environment.id)?.status) {
      ids.add(environment.id)
    }
  }
  return [...ids]
}
function getReachableRuntimeEnvironmentIds(): string[] {
  const ids: string[] = []
  for (const [environmentId, status] of useAppStore.getState().runtimeStatusByEnvironmentId ?? []) {
    if (status?.status) {
      ids.push(environmentId)
    }
  }
  return ids
}

export function registerRuntimeClientIpcBridge(
  unsubs: (() => void)[],
  worktreeRuntime: WorktreeEventRuntime
): () => void {
  const { worktreeChangeRefreshQueue, activateNotifiedWorktree } = worktreeRuntime
  const ensureRuntimeEventRepoKnown = async (
    environmentId: string,
    repoId: string
  ): Promise<void> => {
    if ((useAppStore.getState().repos ?? []).some((repo) => repo.id === repoId)) {
      return
    }
    await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
  }

  const runtimeProjectRefreshScheduler = createRuntimeProjectRefreshScheduler({
    refresh: async (environmentId) => {
      // Why: project events can reveal target CRUD, but known target states already arrive by push.
      void refreshRuntimeEnvironmentSshTargetMetadata(environmentId).catch(() => {})
      const repos = await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
      // Why: the host emits one reposChanged for group/folder-workspace edits too, so those
      // catalogs go stale without this; groups first because folder workspaces resolve owners from them.
      const runtimeOwner = { runtimeEnvironmentId: environmentId }
      // Why: catalogs and worktrees are independent; serializing them put two 15s RPC
      // timeouts ahead of worktree/lineage convergence on a wedged host.
      await Promise.all([
        (async () => {
          await useAppStore.getState().fetchProjectGroups(runtimeOwner)
          await useAppStore.getState().fetchFolderWorkspaces(runtimeOwner)
        })(),
        refreshRuntimeProjectWorktreesAndLineage(
          environmentId,
          repos,
          (repoId, options) => useAppStore.getState().fetchWorktrees(repoId, options),
          (options) => useAppStore.getState().fetchWorktreeLineage(options)
        )
      ])
    },
    onError: (error) => {
      console.error('Failed to refresh runtime projects:', error)
    }
  })

  const handleRuntimeClientEvent = (
    environmentId: string,
    event: RuntimeClientEvent,
    generation = getEnvironmentSshStateGeneration(environmentId)
  ): void => {
    if (event.type === 'worktreeTerminalSleepState') {
      applyHostWorktreeTerminalSleepState(environmentId, event)
      return
    }
    if (event.type === 'terminalSideEffects') {
      dispatchTerminalSideEffectBatch({
        ...event.batch,
        ptyId: toRemoteRuntimePtyId(event.batch.ptyId, environmentId)
      })
      return
    }
    if (event.type === 'nativeChatLaunchDraftResolved') {
      applyNativeChatLaunchDraftResolved(useAppStore.getState(), event)
      return
    }
    if (event.type === 'reposChanged') {
      runtimeProjectRefreshScheduler.request(environmentId)
      return
    }
    if (event.type === 'sshStateChanged') {
      applyRuntimeEnvironmentSshStateChanged(environmentId, event.targetId, event.state, generation)
      return
    }
    if (event.type === 'worktreesChanged') {
      void ensureRuntimeEventRepoKnown(environmentId, event.repoId).then(() =>
        worktreeChangeRefreshQueue.enqueue({
          repoId: event.repoId,
          executionHostId: toRuntimeExecutionHostId(environmentId)
        })
      )
      return
    }
    if (event.type === 'linearLinkedIssueUpdated') {
      void useAppStore
        .getState()
        .refreshLinearIssue(event.identifier, event.workspaceId)
        .catch((error) => {
          console.error('Failed to refresh updated Linear issue:', error)
        })
      return
    }
    void ensureRuntimeEventRepoKnown(environmentId, event.repoId)
      .then(() => activateNotifiedWorktree(event, { allowRuntimeEnvironment: true }))
      .catch((error) => {
        console.error('Failed to activate runtime-created worktree:', error)
      })
  }

  const runtimeClientEventsSync = createRuntimeClientEventsSync({
    getDesiredEnvironmentIds: getRuntimeClientEventEnvironmentIds,
    getSubscriptionKey: (environmentId) => buildRuntimeClientEventEnvironmentKey([environmentId]),
    subscribe: (environmentId, onEvent, onError) => {
      const sshGeneration = getEnvironmentSshStateGeneration(environmentId)
      const runtimeGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
      const runtimeRevision = getRuntimeEnvironmentRevision(environmentId)
      return subscribeRuntimeClientEvents(
        environmentId,
        (event) => {
          if (
            sshGeneration === getEnvironmentSshStateGeneration(environmentId) &&
            runtimeGeneration === getRuntimeEnvironmentConnectionGeneration(environmentId) &&
            runtimeRevision === getRuntimeEnvironmentRevision(environmentId)
          ) {
            onEvent(event)
          }
        },
        onError,
        () => {
          // Why: events during a transport gap are lost; a quick reconnect won't flip unreachable, so refetch (#7970).
          runtimeProjectRefreshScheduler.request(environmentId)
          // Why: sshStateChanged events during the transport gap are lost, so downgrade the possibly-stale bucket, then refetch.
          useAppStore.getState().markEnvironmentSshStateStale(environmentId)
          void hydrateRuntimeEnvironmentSshState(environmentId, { force: true }).catch(() => {})
        }
      )
    },
    onEvent: handleRuntimeClientEvent
  })

  runtimeClientEventsSync.sync()
  // Why: no on-connect repo fetch (PR #2); seed discovery for connected runtimes or remote projects hide until Add-Project.
  let runtimeClientEventEnvironmentIds = getRuntimeClientEventEnvironmentIds()
  for (const environmentId of runtimeClientEventEnvironmentIds) {
    runtimeProjectRefreshScheduler.request(environmentId)
  }
  let runtimeClientEventEnvironmentKey = buildRuntimeClientEventEnvironmentKey(
    runtimeClientEventEnvironmentIds
  )
  let reachableRuntimeEnvironmentIds = getReachableRuntimeEnvironmentIds()
  let reachableRuntimeEnvironmentKey = buildRuntimeClientEventEnvironmentKey(
    reachableRuntimeEnvironmentIds
  )
  const unsubscribeRuntimeEnvironmentStore = useAppStore.subscribe(() => {
    const nextEnvironmentIds = getRuntimeClientEventEnvironmentIds()
    const nextKey = buildRuntimeClientEventEnvironmentKey(nextEnvironmentIds)
    const nextReachableEnvironmentIds = getReachableRuntimeEnvironmentIds()
    const nextReachableKey = buildRuntimeClientEventEnvironmentKey(nextReachableEnvironmentIds)
    if (
      nextKey === runtimeClientEventEnvironmentKey &&
      nextReachableKey === reachableRuntimeEnvironmentKey
    ) {
      return
    }
    for (const environmentId of getRuntimeProjectRefreshEnvironmentIds({
      previousDesired: runtimeClientEventEnvironmentIds,
      nextDesired: nextEnvironmentIds,
      previousReachable: reachableRuntimeEnvironmentIds,
      nextReachable: nextReachableEnvironmentIds
    })) {
      runtimeProjectRefreshScheduler.request(environmentId)
    }
    for (const environmentId of getNewlyDisconnectedRuntimeEnvironmentIds(
      reachableRuntimeEnvironmentIds,
      nextReachableEnvironmentIds
    )) {
      // No-op when the environment has no SSH bucket (e.g. web client).
      useAppStore.getState().markEnvironmentSshStateStale(environmentId)
    }
    runtimeClientEventEnvironmentIds = nextEnvironmentIds
    runtimeClientEventEnvironmentKey = nextKey
    reachableRuntimeEnvironmentIds = nextReachableEnvironmentIds
    reachableRuntimeEnvironmentKey = nextReachableKey
    runtimeClientEventsSync.sync()
  })
  unsubs.push(runtimeClientEventsSync.stop)
  unsubs.push(runtimeProjectRefreshScheduler.stop)

  return unsubscribeRuntimeEnvironmentStore
}

import { useEffect } from 'react'
import { retryAllRemoteRuntimePtyRecoveriesNow } from '@/components/terminal-pane/remote-runtime-pty-recovery-state'
import { useAppStore } from '@/store'
import {
  retryRuntimeStatusRecoveryProbesNow,
  startRuntimeStatusRecoveryProbe
} from './runtime-status-recovery-probe'

function isUnverifiedRuntimeEnvironment(environmentId: string): boolean {
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  return entry !== undefined && entry.status === null
}

export function useRemoteRuntimeRecoveryTriggers(): void {
  useEffect(() => {
    const stopStatusRecoveryProbe = startRuntimeStatusRecoveryProbe({
      isRuntimeEnvironmentUnverified: isUnverifiedRuntimeEnvironment,
      listUnverifiedRuntimeEnvironmentIds: () =>
        [...useAppStore.getState().runtimeStatusByEnvironmentId]
          .filter(([, entry]) => entry.status === null)
          .map(([environmentId]) => environmentId),
      refreshRuntimeEnvironmentStatus: (environmentId) =>
        useAppStore.getState().refreshRuntimeEnvironmentStatus(environmentId),
      subscribeToRecordedStatusChanges: (onChange) =>
        useAppStore.subscribe((state, previous) => {
          // The slice replaces the map only on a real transition, so the reference
          // gate keeps unrelated store writes out of the probe scheduler.
          if (state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId) {
            onChange()
          }
        })
    })
    const advanceRemoteRuntimeRecoveryBackoffs = (): void => {
      // Why: shared control, pane recovery, and status re-probing own independent backoff timers.
      void window.api?.runtimeEnvironments?.retryConnectionsNow?.().catch(() => undefined)
      retryAllRemoteRuntimePtyRecoveriesNow()
      retryRuntimeStatusRecoveryProbesNow()
    }
    window.addEventListener('online', advanceRemoteRuntimeRecoveryBackoffs)
    const unsubscribeSystemResumed =
      typeof window.api?.ui?.onSystemResumed === 'function'
        ? window.api.ui.onSystemResumed(advanceRemoteRuntimeRecoveryBackoffs)
        : null
    return () => {
      window.removeEventListener('online', advanceRemoteRuntimeRecoveryBackoffs)
      unsubscribeSystemResumed?.()
      stopStatusRecoveryProbe()
    }
  }, [])
}

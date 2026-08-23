/**
 * Performs the transport dials `runAutomationHostRecovery` selected.
 *
 * The recovery module only names the host; this is the other half — write the
 * returned status into the store the catalog actually reads. A fire-and-forget
 * `ssh.connect` / `runtimeEnvironments.connect` leaves Unreachable on screen
 * even when the backend came back.
 */

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { connectRuntimeEnvironmentAndRecordStatus } from '@/components/status-bar/runtime-environment-explicit-connect'
import {
  connectRuntimeEnvironmentSshTarget,
  hydrateRuntimeEnvironmentSshState,
  resyncRuntimeEnvironmentSshTargets
} from '@/runtime/runtime-environment-ssh-state'
import { isSshConnectInFlight, trackSshConnect } from '@/ssh/ssh-connect-in-flight'
import { SSH_RECONNECT_UI_TIMEOUT_MS, withUiConnectTimeout } from '@/ssh/ssh-connect-ui-timeout'

const RUNTIME_RECONNECT_TIMEOUT_MS = 15_000

const runtimeConnectInFlight = new Set<string>()

export async function connectAutomationHostRuntime(environmentId: string): Promise<void> {
  if (runtimeConnectInFlight.has(environmentId)) {
    return
  }
  runtimeConnectInFlight.add(environmentId)
  try {
    const reachable = await connectRuntimeEnvironmentAndRecordStatus(
      environmentId,
      RUNTIME_RECONNECT_TIMEOUT_MS
    )
    if (!reachable) {
      toast.error(
        translate(
          'auto.components.automations.hostStatus.action.runtimeConnectFailed',
          'Remote host is not reachable'
        )
      )
      return
    }
    // Why: the catalog projects this environment's SSH targets from the bucket;
    // a successful ping with a stale empty bucket still looks unverified.
    await hydrateRuntimeEnvironmentSshState(environmentId).catch(() => {})
  } finally {
    runtimeConnectInFlight.delete(environmentId)
  }
}

export async function connectAutomationHostSshTarget(args: {
  targetId: string
  environmentId?: string
}): Promise<void> {
  const { targetId, environmentId } = args
  if (isSshConnectInFlight(targetId)) {
    return
  }
  try {
    if (environmentId) {
      await trackSshConnect(targetId, connectRuntimeEnvironmentSshTarget(environmentId, targetId))
      return
    }
    const connectState = await withUiConnectTimeout(
      trackSshConnect(targetId, window.api.ssh.connect({ targetId })),
      SSH_RECONNECT_UI_TIMEOUT_MS
    )
    if (connectState) {
      // Why: ssh.connect can resolve before the global state-change IPC lands.
      useAppStore.getState().setSshConnectionState(targetId, connectState)
    }
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : translate(
            'auto.components.automations.hostStatus.action.sshConnectFailed',
            'SSH connection failed'
          )
    )
    if (environmentId) {
      void resyncRuntimeEnvironmentSshTargets(environmentId).catch(() => {})
      return
    }
    void (async () => {
      const targets = await window.api.ssh.listTargets()
      useAppStore.getState().setSshTargetsMetadata(targets)
      const removedLabels = await window.api.ssh.listRemovedTargetLabels()
      useAppStore.getState().setRemovedSshTargetLabels(removedLabels)
    })().catch(() => {})
  }
}

import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { WorkspaceSessionHostSnapshot } from '../lib/workspace-session-host-persistence'

export type ShutdownCheckpointStageArgs = {
  sessions: WorkspaceSessionHostSnapshot[]
  ui: Partial<PersistedUIState>
}

export type ShutdownCheckpointPersistDeps = {
  shouldCaptureSession: () => boolean
  /** Per-pane failures are already swallowed inside the capture loop. */
  captureTerminalBuffers: () => void
  captureSleepingAgentSessions: () => void
  buildSessionSnapshots: () => WorkspaceSessionHostSnapshot[]
  buildUiPatch: () => Partial<PersistedUIState>
  hasDirtyOpenFiles: () => boolean
  isIntentionalAppRestartInProgress: () => boolean
  stageBeforeUnloadSync: (args: ShutdownCheckpointStageArgs) => void
}

/** The synchronous body of the shutdown checkpoint: capture renderer-owned state,
 *  then stage everything durable through one main-process call. Throwing here fails
 *  the checkpoint and blocks the restart, so only unstageable data may throw. */
export function runShutdownCheckpointPersist(deps: ShutdownCheckpointPersistDeps): void {
  const shouldCaptureSession = deps.shouldCaptureSession()
  if (shouldCaptureSession) {
    deps.captureTerminalBuffers()
    try {
      deps.captureSleepingAgentSessions()
    } catch (error) {
      // Why: the periodic capture refreshes resume records every minute, so a failed
      // quit capture costs at most that window — never strand the restart on it.
      console.error('[app] Sleeping-agent quit capture failed; continuing checkpoint', error)
    }
  }
  // Why: dirty drafts exist only in the full session snapshot, so their loss is the
  // one thing this checkpoint may never trade away for an update.
  const canDegradeToDurableSession = (): boolean =>
    deps.isIntentionalAppRestartInProgress() && !deps.hasDirtyOpenFiles()
  let sessionSnapshots: WorkspaceSessionHostSnapshot[] = []
  let degraded = false
  try {
    sessionSnapshots = shouldCaptureSession ? deps.buildSessionSnapshots() : []
  } catch (error) {
    if (!canDegradeToDurableSession()) {
      throw error
    }
    console.error('[app] Full renderer session snapshot failed; using durable session', error)
    degraded = true
  }
  try {
    deps.stageBeforeUnloadSync({
      sessions: degraded ? [] : sessionSnapshots,
      ui: deps.buildUiPatch()
    })
  } catch (error) {
    // A durable-only stage has nothing safer left to fall back to.
    if (degraded || !canDegradeToDurableSession()) {
      throw error
    }
    console.error('[app] Staging the full renderer session failed; using durable session', error)
    deps.stageBeforeUnloadSync({ sessions: [], ui: deps.buildUiPatch() })
  }
}

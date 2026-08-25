import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { WorkspaceSessionHostSnapshot } from '../lib/workspace-session-host-persistence'
import { recordRendererCrashBreadcrumb } from '../lib/crash-breadcrumb-recorder'

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
  /** True during an intentional restart or an app-level quit/close — the unloads
   *  where losing the full snapshot beats blocking the shutdown outright. */
  isDegradableShutdownInProgress: () => boolean
  stageBeforeUnloadSync: (args: ShutdownCheckpointStageArgs) => void
}

/** Returns the synchronous body of the shutdown checkpoint: capture renderer-owned
 *  state, then stage everything durable through one main-process call. Throwing
 *  fails the checkpoint and blocks the restart, so only unstageable data may throw.
 *
 *  A factory rather than a bare function so full-session staging failures can stay
 *  visible-and-retryable on the first attempt and only degrade on a repeat: a
 *  transient failure gets its retry, a deterministic one can't strand the user. */
export function createShutdownCheckpointPersist(deps: ShutdownCheckpointPersistDeps): () => void {
  let fullStagingFailedOnPriorAttempt = false
  return (): void => {
    const shouldCaptureSession = deps.shouldCaptureSession()
    if (shouldCaptureSession) {
      deps.captureTerminalBuffers()
      try {
        deps.captureSleepingAgentSessions()
      } catch (error) {
        // Why: blocking the shutdown here is what stranded STA-5505. The cost of
        // continuing is real but bounded — done panes keep their weaker live-origin
        // record instead of a durable quit capture — and strictly smaller than the
        // alternative (no update, or a SIGKILL'd quit losing the whole snapshot).
        console.error('[app] Sleeping-agent quit capture failed; continuing checkpoint', error)
        recordRendererCrashBreadcrumb('renderer_shutdown_sleeping_capture_failed', {
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    // Why: dirty drafts exist only in the full session snapshot, so their loss is the
    // one thing this checkpoint may never trade away for an update.
    const canDegradeToDurableSession = (): boolean =>
      deps.isDegradableShutdownInProgress() && !deps.hasDirtyOpenFiles()
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
      if (degraded) {
        throw error
      }
      // Why retry-then-degrade: the first staging failure stays a visible,
      // retryable error — degrading immediately would silently drop just-captured
      // scrollback that a retry may well save. Only a repeat failure trades the
      // full snapshot for an unblocked shutdown. Non-degradable failures never
      // arm the flag, so an unrelated unload can't burn a later restart's retry.
      const keepBlocking = !fullStagingFailedOnPriorAttempt || !canDegradeToDurableSession()
      if (canDegradeToDurableSession()) {
        fullStagingFailedOnPriorAttempt = true
      }
      if (keepBlocking) {
        throw error
      }
      console.error(
        '[app] Staging the full renderer session failed again; using durable session',
        error
      )
      deps.stageBeforeUnloadSync({ sessions: [], ui: deps.buildUiPatch() })
    }
    fullStagingFailedOnPriorAttempt = false
  }
}

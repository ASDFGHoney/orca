import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'

// Why: match the renderer nested-shell settle window so a leaked OSC 133;D
// from an agent's bash/tool child is not treated as the launched agent exiting.
export const COMMAND_FINISHED_LAUNCH_AUTHORITY_SETTLE_MS = 350

/**
 * True when a command-finished OSC should retire launched-agent hook authority.
 *
 * Nested tool shells leak OSC 133;D onto the main PTY while the agent is still
 * foreground. Loss of contact (null) is unverifiable, not exited, so it must
 * not retire a live pane.
 */
export function shouldRetireLaunchAuthorityOnCommandFinished(
  foregroundProcess: string | null
): boolean {
  if (!foregroundProcess) {
    return false
  }
  if (recognizeAgentProcess(foregroundProcess)) {
    return false
  }
  return isShellProcess(foregroundProcess)
}

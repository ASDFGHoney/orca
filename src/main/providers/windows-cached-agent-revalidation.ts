import { isShellProcess } from '../../shared/shell-process-detection'

/**
 * How long a cached agent identity may survive on job evidence alone.
 *
 * The job is a SUPERSET of the console: it keeps console-detached descendants,
 * so "something besides the shell is alive" cannot tell a working agent from a
 * leftover. A WSL pane always has some, so treating that as proof of life pins
 * a dead agent's name forever (#9258's bug, reached by a new route). Age is the
 * tiebreak. 5x the renderer's 6s confirm ladder.
 */
export const WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS = 30_000

/** Whether job membership can revalidate a cached agent without a process scan. */
export function canRevalidateCachedAgentWithoutScan(
  cachedAgentName: string | null,
  fallbackProcess: string | null
): boolean {
  return (
    cachedAgentName !== null &&
    fallbackProcess !== null &&
    // Why: a generic wrapper may outlive the agent; only the shell fallback is
    // the known unreliable Windows exit signal this cache is allowed to bridge.
    isShellProcess(fallbackProcess)
  )
}

import { isShellProcess } from '../../shared/shell-process-detection'

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

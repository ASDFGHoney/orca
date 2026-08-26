/**
 * Re-probes runtime environments whose recorded status is `null`.
 *
 * `runtimeStatusByEnvironmentId` is written only by explicit probes (boot
 * hydration, the status-bar host dropdown, the settings pane, connect/disconnect).
 * Nothing feeds a transport that reconnected on its own back into it, so one
 * failed boot probe left a reachable host reading "disconnected" for the whole
 * session (#16516).
 *
 * Neither trigger here decides reachability: both re-run the real
 * `status.get` probe and let its answer stand. Loss of contact stays
 * unverifiable, never "exited" — see docs/reference/ssh-execution-boundary.md.
 */

const RECOVERY_PROBE_BASE_DELAY_MS = 5_000
const RECOVERY_PROBE_MAX_DELAY_MS = 60_000

export type RuntimeStatusRecoveryPort = {
  /** True when the environment has a status entry whose last probe recorded `null`. */
  isRuntimeEnvironmentUnverified: (environmentId: string) => boolean
  listUnverifiedRuntimeEnvironmentIds: () => readonly string[]
  refreshRuntimeEnvironmentStatus: (environmentId: string) => Promise<boolean>
  /** Reports every change to the recorded statuses. Without it a host that goes
   * unreachable after start — the boot probe included — never starts its clock. */
  subscribeToRecordedStatusChanges: (onChange: () => void) => () => void
}

let port: RuntimeStatusRecoveryPort | null = null
let timer: ReturnType<typeof setTimeout> | null = null
type RecoveryBackoff = { failures: number; nextAttemptAt: number }
/** Per-environment retry budget. Each host backs off on its own clock, so one
 * freshly-failing host cannot drag a long-unreachable one back to the base interval. */
const backoffByEnvironment = new Map<string, RecoveryBackoff>()
const probingEnvironments = new Set<string>()

function backoffDelayMs(failures: number): number {
  return Math.min(RECOVERY_PROBE_BASE_DELAY_MS * 2 ** failures, RECOVERY_PROBE_MAX_DELAY_MS)
}

function backoffFor(environmentId: string, now: number): RecoveryBackoff {
  let entry = backoffByEnvironment.get(environmentId)
  if (!entry) {
    // First sighting: the caller's own probe just recorded this host unreachable,
    // so wait one interval rather than re-asking the question it answered.
    entry = { failures: 0, nextAttemptAt: now + RECOVERY_PROBE_BASE_DELAY_MS }
    backoffByEnvironment.set(environmentId, entry)
  }
  return entry
}

function recordProbeFailure(environmentId: string): void {
  const now = Date.now()
  const entry = backoffFor(environmentId, now)
  entry.failures += 1
  entry.nextAttemptAt = now + backoffDelayMs(entry.failures)
}

function probe(environmentId: string): void {
  const active = port
  if (!active || probingEnvironments.has(environmentId)) {
    return
  }
  probingEnvironments.add(environmentId)
  void active
    .refreshRuntimeEnvironmentStatus(environmentId)
    .then((reachable) => {
      if (reachable) {
        backoffByEnvironment.delete(environmentId)
      } else {
        recordProbeFailure(environmentId)
      }
    })
    .catch(() => recordProbeFailure(environmentId))
    .finally(() => {
      probingEnvironments.delete(environmentId)
      scheduleNextSweep()
    })
}

function scheduleNextSweep(): void {
  if (timer !== null || !port) {
    return
  }
  const unverified = port.listUnverifiedRuntimeEnvironmentIds()
  if (unverified.length === 0) {
    // Why: nothing to recover — stay idle instead of holding a forever-ticking timer.
    backoffByEnvironment.clear()
    return
  }
  const now = Date.now()
  const earliestAttemptAt = Math.min(
    ...unverified.map((environmentId) => backoffFor(environmentId, now).nextAttemptAt)
  )
  // Recovered and removed environments must not keep a retry budget alive.
  const stillUnverified = new Set(unverified)
  for (const environmentId of backoffByEnvironment.keys()) {
    if (!stillUnverified.has(environmentId)) {
      backoffByEnvironment.delete(environmentId)
    }
  }
  timer = setTimeout(
    () => {
      timer = null
      sweep()
    },
    Math.max(0, earliestAttemptAt - now)
  )
}

function sweep(): void {
  const active = port
  if (!active) {
    return
  }
  const now = Date.now()
  let probed = false
  for (const environmentId of active.listUnverifiedRuntimeEnvironmentIds()) {
    if (backoffFor(environmentId, now).nextAttemptAt <= now) {
      probe(environmentId)
      probed = true
    }
  }
  // Why: a sweep that probed nothing still has to re-arm for whoever is due next.
  if (!probed || probingEnvironments.size === 0) {
    scheduleNextSweep()
  }
}

/**
 * Records that the renderer just exchanged traffic with this environment.
 *
 * Traffic is evidence the host is reachable, not proof of its state: consumers
 * read the whole `RuntimeStatus` (capabilities, remote control, workspace
 * window), so this only asks for a fresh probe.
 */
export function noteRuntimeEnvironmentReachable(environmentId: string): void {
  if (!port?.isRuntimeEnvironmentUnverified(environmentId)) {
    return
  }
  // A host that just answered deserves the full retry budget again.
  backoffByEnvironment.delete(environmentId)
  probe(environmentId)
}

export function startRuntimeStatusRecoveryProbe(next: RuntimeStatusRecoveryPort): () => void {
  port = next
  const unsubscribe = next.subscribeToRecordedStatusChanges(() => {
    // Re-arm against the new set; each host keeps the retry budget it had earned.
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    scheduleNextSweep()
  })
  scheduleNextSweep()
  return () => {
    unsubscribe()
    if (port !== next) {
      return
    }
    port = null
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    backoffByEnvironment.clear()
    probingEnvironments.clear()
  }
}

/** Re-probes every unverified environment immediately, ignoring its backoff. */
export function retryRuntimeStatusRecoveryProbesNow(): void {
  const now = Date.now()
  for (const environmentId of port?.listUnverifiedRuntimeEnvironmentIds() ?? []) {
    backoffByEnvironment.set(environmentId, { failures: 0, nextAttemptAt: now })
  }
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  sweep()
}

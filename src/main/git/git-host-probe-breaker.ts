import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from '../crash-reporting/durable-crash-breadcrumb'

/**
 * Per-host admission control for the git host probes behind forge detection
 * (crash f2521868).
 *
 * Why: the remote-URL probe's deadline makes a wedged call *settle* rather than
 * hang, so the in-flight coalescer drops its entry and the very next poll
 * re-issues — at whatever concurrency the pollers happen to have. In the
 * reported hour that was 431 calls, 414 of them dying on the deadline, peaking
 * at 15 concurrent `wsl.exe` children whose contention stretched a 30s deadline
 * into a 120s span, so the storm fed itself and never recovered. Nothing here
 * changes how a probe is run; it decides how hard a host that is not answering
 * may still be pushed, and it always keeps a way back.
 *
 * State is scoped to the host that executes git — the native host, one WSL
 * distro, one SSH connection generation — so a dead distro can never gate the
 * repos of a host that is fine.
 */

/**
 * One unanswered probe is a blip: a cold WSL interop call, a dropped relay
 * frame. Two means the host has spent a minute answering nothing, so stop
 * fanning out. Three means it is wedged, and probing it on demand only feeds
 * the loop. Tripping any earlier would punish WSL's genuinely slow cold start,
 * which is exactly when a user opening Orca deserves a real answer.
 */
export const GIT_HOST_PROBE_SERIALIZE_AFTER = 2
export const GIT_HOST_PROBE_OPEN_AFTER = 3

/**
 * The incident peaked at 15 concurrent children, so a ceiling only bounds
 * anything if it sits under that. A burst wider than this queues rather than
 * fails — on a healthy host each probe is a sub-second config read, so the
 * waves cost far less than one contended spawn. A degraded host gets one slot.
 */
export const GIT_HOST_PROBE_HEALTHY_CONCURRENCY = 8

/**
 * A probe costs one full deadline, so retrying sooner than that spends more
 * wall time inside the host than outside it. The ceiling is the longest span a
 * single wedged call was observed to hold the host: past that, waiting longer
 * buys no further idle time and only delays an unattended recovery.
 */
export const GIT_HOST_PROBE_BASE_COOLDOWN_MS = 30_000
export const GIT_HOST_PROBE_MAX_COOLDOWN_MS = 120_000

/** Past this the fan-out is pathological; shed rather than buffer it. */
const MAX_QUEUED_PER_HOST = 64
/** Reconnect churn mints a key per SSH generation, so bound retained hosts. */
const MAX_TRACKED_HOSTS = 64
/** A two-hour outage must still be legible in a 30-entry breadcrumb ring. */
const STILL_OPEN_BREADCRUMB_INTERVAL_MS = 5 * 60_000
/** Keeps `2 ** openCount` away from Infinity on a host down for days. */
const MAX_COOLDOWN_DOUBLINGS = 20

type HostProbeState = {
  consecutiveUnavailable: number
  openCount: number
  blockedUntilMs: number
  inFlight: number
  queued: number
  waiters: (() => void)[]
  reportedOpen: boolean
}

type Admission = 'closed' | 'half-open' | 'blocked' | 'queue'

export type GitHostProbeBlockedError = Error & { gitHostProbeBlocked: true }

export type GitProbeHostParts = {
  connectionId?: string | null
  connectionGeneration?: number
  wslDistro?: string
}

const hostStates = new Map<string, HostProbeState>()

/** Scopes probe state to the runtime that actually executes git. */
export function gitProbeHostKey(parts: GitProbeHostParts): string {
  if (parts.connectionId) {
    // Why: a reconnect retires the failing transport, so the new generation is a
    // new key and starts trusted instead of serving out the old one's cooldown.
    return `ssh:${parts.connectionId}:${parts.connectionGeneration ?? 0}`
  }
  return parts.wslDistro ? `wsl:${parts.wslDistro}` : 'native'
}

export function isGitHostProbeBlockedError(error: unknown): error is GitHostProbeBlockedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { gitHostProbeBlocked?: unknown }).gitHostProbeBlocked === true
  )
}

/**
 * Runs `probe` under this host's failure budget. `isUnavailableError` decides
 * which rejections are the host failing to answer — anything else, including a
 * repo saying it has no such remote, is proof the host is alive and clears the
 * budget. Rejects without running `probe` when the host is being backed off.
 */
export async function runGuardedGitHostProbe<T>(
  hostKey: string,
  probe: () => Promise<T>,
  isUnavailableError: (error: unknown) => boolean
): Promise<T> {
  const state = getHostState(hostKey)
  const halfOpen = await admit(hostKey, state)
  try {
    const result = await probe()
    recordAnswered(hostKey, state)
    return result
  } catch (error) {
    if (isUnavailableError(error)) {
      recordUnavailable(hostKey, state, halfOpen)
    } else {
      recordAnswered(hostKey, state)
    }
    throw error
  } finally {
    release(hostKey, state)
  }
}

/** Resolves to true when this probe is the trial that decides whether the host is back. */
async function admit(hostKey: string, state: HostProbeState): Promise<boolean> {
  for (;;) {
    const decision = tryAdmit(state)
    if (decision === 'blocked') {
      throw createBlockedError(hostKey, state)
    }
    if (decision !== 'queue') {
      return decision === 'half-open'
    }
    if (state.queued >= MAX_QUEUED_PER_HOST) {
      throw createBlockedError(hostKey, state)
    }
    state.queued += 1
    try {
      await new Promise<void>((wake) => state.waiters.push(wake))
    } finally {
      state.queued -= 1
    }
  }
}

function tryAdmit(state: HostProbeState): Admission {
  const now = Date.now()
  if (state.blockedUntilMs > now) {
    return 'blocked'
  }
  if (state.blockedUntilMs > 0) {
    // Cooled down: exactly one trial probe gets to decide, alone.
    if (state.inFlight > 0) {
      return 'blocked'
    }
    state.inFlight += 1
    return 'half-open'
  }
  const ceiling =
    state.consecutiveUnavailable >= GIT_HOST_PROBE_SERIALIZE_AFTER
      ? 1
      : GIT_HOST_PROBE_HEALTHY_CONCURRENCY
  if (state.inFlight >= ceiling) {
    // Why: a caller queued behind a probe that is already failing would wait a
    // whole deadline to learn what shedding tells it now, and its poll returns.
    return ceiling === 1 ? 'blocked' : 'queue'
  }
  state.inFlight += 1
  return 'closed'
}

function recordAnswered(hostKey: string, state: HostProbeState): void {
  const unansweredProbes = state.consecutiveUnavailable
  const wasOpen = state.reportedOpen
  state.consecutiveUnavailable = 0
  state.openCount = 0
  state.blockedUntilMs = 0
  state.reportedOpen = false
  if (wasOpen) {
    recordDurableCrashBreadcrumb('git_host_probe_recovered', { host: hostKey, unansweredProbes })
  }
}

function recordUnavailable(hostKey: string, state: HostProbeState, halfOpen: boolean): void {
  state.consecutiveUnavailable += 1
  if (halfOpen) {
    openBreaker(hostKey, state)
    return
  }
  // Why: probes admitted before the breaker opened settle together, and letting
  // each escalate would jump straight to the ceiling on the first failure wave.
  if (state.blockedUntilMs > 0 || state.consecutiveUnavailable < GIT_HOST_PROBE_OPEN_AFTER) {
    return
  }
  openBreaker(hostKey, state)
}

function openBreaker(hostKey: string, state: HostProbeState): void {
  state.openCount += 1
  state.blockedUntilMs = Date.now() + cooldownMs(state.openCount)
  const data = {
    host: hostKey,
    unansweredProbes: state.consecutiveUnavailable,
    cooldownMs: state.blockedUntilMs - Date.now()
  }
  if (!state.reportedOpen) {
    state.reportedOpen = true
    recordDurableCrashBreadcrumb('git_host_probe_breaker_open', data)
    return
  }
  recordCoalescedDurableCrashBreadcrumb({
    name: 'git_host_probe_breaker_still_open',
    data,
    coalesceKey: `git-host-probe:${hostKey}`,
    minIntervalMs: STILL_OPEN_BREADCRUMB_INTERVAL_MS
  })
}

function cooldownMs(openCount: number): number {
  const doublings = Math.min(Math.max(0, openCount - 1), MAX_COOLDOWN_DOUBLINGS)
  return Math.min(GIT_HOST_PROBE_BASE_COOLDOWN_MS * 2 ** doublings, GIT_HOST_PROBE_MAX_COOLDOWN_MS)
}

function release(hostKey: string, state: HostProbeState): void {
  state.inFlight -= 1
  const waiters = state.waiters.splice(0)
  for (const wake of waiters) {
    wake()
  }
  // Why: a host with nothing left to remember costs nothing to forget, which is
  // what keeps the healthy case from retaining an entry per repo host forever.
  if (hostStates.get(hostKey) === state && isForgettable(state)) {
    hostStates.delete(hostKey)
  }
}

function isForgettable(state: HostProbeState): boolean {
  return isIdle(state) && state.consecutiveUnavailable === 0 && state.blockedUntilMs === 0
}

function isIdle(state: HostProbeState): boolean {
  return state.inFlight === 0 && state.queued === 0 && state.waiters.length === 0
}

function createBlockedError(hostKey: string, state: HostProbeState): GitHostProbeBlockedError {
  const remainingMs = state.blockedUntilMs - Date.now()
  const message =
    remainingMs > 0
      ? `Git host ${hostKey} did not answer ${state.consecutiveUnavailable} consecutive probes; suppressed for ~${Math.ceil(remainingMs / 1000)}s.`
      : `Git host ${hostKey} did not answer ${state.consecutiveUnavailable} consecutive probes; shed while an earlier probe is still outstanding.`
  return Object.assign(new Error(message), { gitHostProbeBlocked: true as const })
}

function getHostState(hostKey: string): HostProbeState {
  const existing = hostStates.get(hostKey)
  if (existing) {
    return existing
  }
  const state: HostProbeState = {
    consecutiveUnavailable: 0,
    openCount: 0,
    blockedUntilMs: 0,
    inFlight: 0,
    queued: 0,
    waiters: [],
    reportedOpen: false
  }
  hostStates.set(hostKey, state)
  evictIdleHostStates()
  return state
}

function evictIdleHostStates(): void {
  if (hostStates.size <= MAX_TRACKED_HOSTS) {
    return
  }
  for (const [key, state] of hostStates) {
    if (hostStates.size <= MAX_TRACKED_HOSTS) {
      return
    }
    // Never drop a host with live slot accounting; its release would orphan.
    if (isIdle(state)) {
      hostStates.delete(key)
    }
  }
}

/** @internal — tests only. */
export function _resetGitHostProbeBreaker(): void {
  hostStates.clear()
}

/** @internal — tests only. */
export function _getGitHostProbeState(
  hostKey: string
): { consecutiveUnavailable: number; blockedUntilMs: number; inFlight: number } | null {
  const state = hostStates.get(hostKey)
  return state
    ? {
        consecutiveUnavailable: state.consecutiveUnavailable,
        blockedUntilMs: state.blockedUntilMs,
        inFlight: state.inFlight
      }
    : null
}

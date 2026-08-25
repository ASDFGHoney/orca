import type { CrashReportBreadcrumb, CrashReportDetailValue } from '../../shared/crash-reporting'
import {
  RENDERER_MEMORY_HEARTBEAT_BREADCRUMB,
  RENDERER_MEMORY_HEARTBEAT_INTERVAL_MS
} from '../../shared/renderer-memory-heartbeat'
import { SYSTEM_SLEPT_BREADCRUMB } from '../../shared/system-sleep-breadcrumb'

// ─── Renderer silence before a process-gone death ───────────────────
// Why: the renderer emits a memory breadcrumb on a fixed interval, so the wall
// time between the last one and the report separates "a healthy app was force
// killed" from "the renderer had been wedged for 13 minutes" — the distinction
// the killed/1 cluster otherwise cannot make.
//
// Honesty limits, deliberately left to the reader instead of a verdict field:
// - Attribution is stamped, never assumed. `crashed-renderer` means the crumb
//   carried the dead renderer's origin; `unattributed` means it could be any
//   renderer (child-process deaths, or an event with no webContentsId).
// - Silence is not proof of a wedge. Chromium throttles background timers, so a
//   hidden or occluded window stretches the cadence on its own.
// - OS sleep stops renderer timers outright, so recorded suspend spans are
//   subtracted and reported separately; a sleep too short to record, a dark wake
//   that never fires resume, or a resume crumb evicted from the ring still lands
//   in the awake figure.
// - It is read off the report's own breadcrumb snapshot, so ring eviction shows
//   up as `none` rather than as a silently wrong duration.

type CrashReportDetails = Record<string, CrashReportDetailValue>

type HeartbeatMatch = {
  createdAt: string
  atMs: number
  attributed: boolean
}

function heartbeatMatch(
  breadcrumb: CrashReportBreadcrumb,
  reporterOrigin: string | undefined
): HeartbeatMatch | null {
  if (breadcrumb.name !== RENDERER_MEMORY_HEARTBEAT_BREADCRUMB) {
    return null
  }
  const atMs = Date.parse(breadcrumb.createdAt)
  if (!Number.isFinite(atMs)) {
    return null
  }
  return {
    createdAt: breadcrumb.createdAt,
    atMs,
    attributed: reporterOrigin !== undefined && breadcrumb.origin === reporterOrigin
  }
}

/** Newest heartbeat, preferring a provably-attributed one over a newer anonymous one. */
function lastHeartbeat(
  breadcrumbs: readonly CrashReportBreadcrumb[],
  reporterOrigin: string | undefined
): HeartbeatMatch | null {
  let best: HeartbeatMatch | null = null
  for (const breadcrumb of breadcrumbs) {
    const match = heartbeatMatch(breadcrumb, reporterOrigin)
    if (!match) {
      continue
    }
    if (
      !best ||
      (match.attributed === best.attributed ? match.atMs > best.atMs : match.attributed)
    ) {
      best = match
    }
  }
  return best
}

/** Sleep is stamped at resume, so the crumb's own time is the wake edge of the span. */
function suspendedMsWithin(
  breadcrumbs: readonly CrashReportBreadcrumb[],
  fromMs: number,
  toMs: number
): number {
  let total = 0
  for (const breadcrumb of breadcrumbs) {
    if (breadcrumb.name !== SYSTEM_SLEPT_BREADCRUMB) {
      continue
    }
    const resumedAtMs = Date.parse(breadcrumb.createdAt)
    const suspendedForMs = breadcrumb.data?.suspendedForMs
    if (
      !Number.isFinite(resumedAtMs) ||
      typeof suspendedForMs !== 'number' ||
      !Number.isFinite(suspendedForMs) ||
      suspendedForMs <= 0
    ) {
      continue
    }
    total += Math.max(
      0,
      Math.min(toMs, resumedAtMs) - Math.max(fromMs, resumedAtMs - suspendedForMs)
    )
  }
  return total
}

export function rendererHeartbeatSilenceDetails(
  breadcrumbs: readonly CrashReportBreadcrumb[],
  reporterOrigin: string | undefined,
  nowMs: number
): CrashReportDetails {
  const last = lastHeartbeat(breadcrumbs, reporterOrigin)
  if (!last) {
    // Explicit, so a reader can tell "no heartbeat in evidence" from a build
    // that never stamped the field.
    return { rendererHeartbeatStatus: 'none' }
  }
  const silenceMs = Math.max(0, nowMs - last.atMs)
  // Clamped: overlapping suspend crumbs must never explain more than the gap itself.
  const suspendedMs = Math.min(silenceMs, suspendedMsWithin(breadcrumbs, last.atMs, nowMs))
  const awakeSilenceMs = silenceMs - suspendedMs
  return {
    rendererHeartbeatStatus: 'observed',
    rendererHeartbeatAttribution: last.attributed ? 'crashed-renderer' : 'unattributed',
    rendererHeartbeatLastAt: last.createdAt,
    rendererHeartbeatSilenceMs: silenceMs,
    ...(suspendedMs > 0
      ? {
          rendererHeartbeatSuspendedMs: suspendedMs,
          rendererHeartbeatAwakeSilenceMs: awakeSilenceMs
        }
      : {}),
    rendererHeartbeatIntervalMs: RENDERER_MEMORY_HEARTBEAT_INTERVAL_MS,
    // Why: counted off the awake span, so an overnight sleep is not a 479-interval wedge.
    rendererHeartbeatMissedIntervals: Math.floor(
      awakeSilenceMs / RENDERER_MEMORY_HEARTBEAT_INTERVAL_MS
    )
  }
}

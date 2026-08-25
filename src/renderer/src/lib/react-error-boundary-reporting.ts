import type React from 'react'
import {
  RENDERER_ERROR_DEDUPE_MS,
  type CrashReportRecord,
  type ReactErrorBoundaryReportArgs
} from '../../../shared/crash-reporting'
import { getReactErrorBoundaryAttribution } from '../../../shared/react-update-depth-attribution'

type RendererErrorContext = Pick<
  ReactErrorBoundaryReportArgs,
  'activeView' | 'activeModal' | 'activeTabType' | 'activeRightSidebarTab' | 'hasActiveWorktree'
>

type BuildReportArgsInput = {
  boundaryId: string
  surface: ReactErrorBoundaryReportArgs['surface']
  error: unknown
  errorInfo?: React.ErrorInfo
  context?: RendererErrorContext
  /** When the crash was observed; callers that throttle themselves pass their own instant so the two windows cannot drift. */
  observedAt?: number
  /**
   * Opt in to re-reporting an identical signature once RENDERER_ERROR_DEDUPE_MS has passed. Off by
   * default because a non-deduped report re-opens the modal crash dialog, and a mounted boundary
   * with a resetKey re-catches the same signature for as long as the user keeps reopening its
   * surface. Only self-throttled callers that need a runaway to stay visible should set it.
   */
  repeatAfterDedupeWindow?: boolean
}

const reportedRendererErrorKeyTimes = new Map<string, number>()
const MAX_REPORTED_RENDERER_ERROR_KEYS = 50
let pendingReactErrorBoundaryReport: CrashReportRecord | null = null

export const REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT =
  'orca:react-error-boundary-report-available'

function stringFromThrown(value: unknown): { name: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: value.message || String(value),
      ...(value.stack ? { stack: value.stack } : {})
    }
  }

  return {
    name: 'NonErrorThrown',
    message: String(value)
  }
}

async function collectRendererErrorContext(): Promise<RendererErrorContext> {
  try {
    const { useAppStore } = await import('@/store')
    const state = useAppStore.getState()
    return {
      activeView: state.activeView,
      activeModal: state.activeModal,
      activeTabType: state.activeTabType,
      activeRightSidebarTab: state.rightSidebarTab,
      hasActiveWorktree: state.activeWorktreeId !== null
    }
  } catch {
    return {}
  }
}

export function buildReactErrorBoundaryReportArgs({
  boundaryId,
  surface,
  error,
  errorInfo,
  context
}: BuildReportArgsInput): ReactErrorBoundaryReportArgs {
  const fields = stringFromThrown(error)
  const componentStack = errorInfo?.componentStack?.trim()
  // Derived here, not per boundary: React #185 lands on a bystander, so every boundary needs the caveat.
  const attribution = getReactErrorBoundaryAttribution(error)
  return {
    boundaryId,
    surface,
    errorName: fields.name,
    errorMessage: fields.message,
    ...(fields.stack ? { errorStack: fields.stack } : {}),
    ...(componentStack ? { componentStack } : {}),
    ...(attribution ? { attribution } : {}),
    ...(context?.activeView ? { activeView: context.activeView } : {}),
    ...(context?.activeModal !== undefined ? { activeModal: context.activeModal } : {}),
    ...(context?.activeTabType ? { activeTabType: context.activeTabType } : {}),
    ...(context?.activeRightSidebarTab
      ? { activeRightSidebarTab: context.activeRightSidebarTab }
      : {}),
    ...(context?.hasActiveWorktree !== undefined
      ? { hasActiveWorktree: context.hasActiveWorktree }
      : {})
  }
}

/**
 * Default is once per session (the count cap is the only eviction), because every non-deduped report
 * opens the modal crash dialog. `repeatAfterDedupeWindow` callers get the main process's own window
 * instead, so a self-throttled runaway is never silently dropped on this side.
 */
function rememberRendererErrorKey(
  key: string,
  observedAt: number,
  repeatAfterDedupeWindow: boolean
): boolean {
  const rememberedAt = reportedRendererErrorKeyTimes.get(key)
  if (rememberedAt !== undefined) {
    if (!repeatAfterDedupeWindow) {
      return false
    }
    const elapsed = observedAt - rememberedAt
    // A backwards clock jump reads as negative; report rather than stay silent until the clock catches up.
    if (elapsed >= 0 && elapsed < RENDERER_ERROR_DEDUPE_MS) {
      return false
    }
  }
  reportedRendererErrorKeyTimes.delete(key) // re-insert so the count cap evicts by last report, not first
  reportedRendererErrorKeyTimes.set(key, observedAt)
  while (reportedRendererErrorKeyTimes.size > MAX_REPORTED_RENDERER_ERROR_KEYS) {
    const oldestKey = reportedRendererErrorKeyTimes.keys().next().value
    if (oldestKey === undefined) {
      return true
    }
    reportedRendererErrorKeyTimes.delete(oldestKey)
  }
  return true
}

function getRendererErrorKey(args: ReactErrorBoundaryReportArgs): string {
  return JSON.stringify({
    boundaryId: args.boundaryId,
    surface: args.surface,
    errorName: args.errorName,
    errorMessage: args.errorMessage,
    componentStack: args.componentStack
  })
}

export function takePendingReactErrorBoundaryReport(): CrashReportRecord | null {
  const report = pendingReactErrorBoundaryReport
  pendingReactErrorBoundaryReport = null
  return report
}

function notifyReactErrorBoundaryReportAvailable(report: CrashReportRecord): void {
  pendingReactErrorBoundaryReport = report
  window.dispatchEvent(new CustomEvent(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT))
}

export async function reportReactErrorBoundaryCrash(
  input: Omit<BuildReportArgsInput, 'context'>
): Promise<void> {
  const observedAt = input.observedAt ?? Date.now()
  const context = await collectRendererErrorContext()
  const args = buildReactErrorBoundaryReportArgs({ ...input, context })
  if (
    !rememberRendererErrorKey(
      getRendererErrorKey(args),
      observedAt,
      input.repeatAfterDedupeWindow === true
    )
  ) {
    return
  }

  try {
    const result = await window.api?.crashReports?.recordRendererError?.(args)
    if (result && !result.ok) {
      console.warn('[react-error-boundary] Failed to record renderer crash:', result.error)
      return
    }
    if (result?.ok && result.report && !result.deduped) {
      notifyReactErrorBoundaryReportAvailable(result.report)
    }
  } catch (error) {
    console.warn('[react-error-boundary] Crash reporting IPC failed:', error)
  }
}

export function clearReactErrorBoundaryReportingForTest(): void {
  reportedRendererErrorKeyTimes.clear()
  pendingReactErrorBoundaryReport = null
}

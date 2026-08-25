import type * as pty from 'node-pty'
import { win32 as pathWin32 } from 'node:path'
import { getAgentForegroundContextPaths } from '../../providers/agent-foreground-context-paths'
import { resolveAgentForegroundProcessWithAvailability } from '../../providers/agent-foreground-process'
import { WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS } from '../../providers/windows-cached-agent-revalidation'
import { readWindowsPtyJobProcessIds } from '../../providers/windows-pty-job-membership'
import { readWindowsConsoleAttachedProcessIds } from '../../providers/windows-console-attached-processes'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess,
  type RecognizedAgentProcess
} from '../../../shared/agent-process-recognition'
import { shouldInspectOuterWrapperForegroundProcess } from '../../../shared/foreground-wrapper-agent'
import { isShellProcess } from '../../../shared/shell-process-detection'
import { parsePtySessionId } from '../pty-session-id'

const FOREGROUND_AGENT_CACHE_TTL_MS = 1000
const SHELL_FOREGROUND_REFRESH_RETRY_MS = 5_000
const WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS = 15_000
const SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS = 10_000
const STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS = 5_000

function normalizeForegroundProcessName(processName: string | null | undefined): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  if (!trimmed || trimmed === 'xterm-256color') {
    return null
  }
  return trimmed.split(/[\\/]/).pop() || null
}

function resolveFallbackForegroundProcess(
  processName: string | null | undefined,
  shellPath: string
): string | null {
  const normalized = normalizeForegroundProcessName(processName)
  if (normalized || process.platform !== 'win32') {
    return normalized
  }
  return normalizeForegroundProcessName(pathWin32.basename(shellPath))
}

function shouldInspectOuterWrapperFallback(processName: string | null): boolean {
  const recognized = recognizeAgentProcess(processName)
  return recognized !== null && shouldInspectOuterWrapperForegroundProcess(recognized)
}

export type PtyForegroundProcessTracker = {
  recordOutput(data: string): void
  markDead(): void
  getForegroundProcess(): string | null
  confirmForegroundProcess(): Promise<string | null>
}

export function createPtyForegroundProcessTracker(args: {
  process: pty.IPty
  shellPath: string
  cwd?: string
  sessionId: string
  startupAgentRecognition: RecognizedAgentProcess | null
  isDead: () => boolean
}): PtyForegroundProcessTracker {
  const proc = args.process
  let lastOutputAt = 0
  let cachedAgentForeground: { processName: string; refreshedAt: number } | null = null
  const contextPaths = getAgentForegroundContextPaths({
    cwd: args.cwd,
    worktreeId: parsePtySessionId(args.sessionId).worktreeId
  })
  let startupAgentForeground: { processName: string; expiresAt: number } | null =
    args.startupAgentRecognition
      ? {
          processName: args.startupAgentRecognition.processName,
          expiresAt: Date.now() + STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS
        }
      : null
  let foregroundRefreshInFlight = false
  let lastForegroundRefreshStartedAt = 0
  const getFallbackProcess = (): string | null =>
    resolveFallbackForegroundProcess(proc.process, args.shellPath)
  const getActiveStartupAgent = (
    now = Date.now()
  ): { processName: string; expiresAt: number } | null => {
    if (!startupAgentForeground) {
      return null
    }
    if (now > startupAgentForeground.expiresAt) {
      startupAgentForeground = null
      return null
    }
    return startupAgentForeground
  }
  const shouldInspectFallback = (fallbackProcess: string | null): boolean =>
    fallbackProcess !== null &&
    (isShellProcess(fallbackProcess) ||
      isAgentForegroundWrapperProcess(fallbackProcess) ||
      shouldInspectOuterWrapperFallback(fallbackProcess) ||
      process.platform !== 'win32')

  const scheduleRefresh = (fallbackProcess: string | null): void => {
    if (args.isDead() || !proc.pid) {
      return
    }
    const fallbackIsShell = fallbackProcess !== null && isShellProcess(fallbackProcess)
    const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
    if (
      !fallbackProcess ||
      (fallbackRecognition !== null &&
        !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
      !shouldInspectFallback(fallbackProcess)
    ) {
      return
    }
    const now = Date.now()
    const idleNoEvidenceShell =
      fallbackIsShell && !getActiveStartupAgent(now) && !cachedAgentForeground
    const retryMs = !idleNoEvidenceShell
      ? FOREGROUND_AGENT_CACHE_TTL_MS
      : process.platform === 'win32' && now - lastOutputAt > SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS
        ? WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS
        : SHELL_FOREGROUND_REFRESH_RETRY_MS
    if (foregroundRefreshInFlight || now - lastForegroundRefreshStartedAt < retryMs) {
      return
    }
    foregroundRefreshInFlight = true
    lastForegroundRefreshStartedAt = now
    const retireStaleForegroundIdentity = ({ onlyWhenAged = false } = {}): void => {
      const currentFallbackProcess = getFallbackProcess()
      const identityAgeMs =
        cachedAgentForeground === null ? 0 : Date.now() - cachedAgentForeground.refreshedAt
      if (
        fallbackIsShell &&
        !getActiveStartupAgent() &&
        currentFallbackProcess !== null &&
        isShellProcess(currentFallbackProcess) &&
        (!onlyWhenAged || identityAgeMs > WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS)
      ) {
        cachedAgentForeground = null
        startupAgentForeground = null
      } else if (
        cachedAgentForeground !== null &&
        Date.now() - cachedAgentForeground.refreshedAt > FOREGROUND_AGENT_CACHE_TTL_MS &&
        currentFallbackProcess !== null &&
        isAgentForegroundWrapperProcess(currentFallbackProcess)
      ) {
        cachedAgentForeground = null
      }
    }
    void resolveAgentForegroundProcessWithAvailability(proc.pid, fallbackProcess, {
      contextPaths
    })
      .then<string | void>(({ processName, available }) => {
        if (args.isDead() || !available) {
          return
        }
        if (!processName || !recognizeAgentProcess(processName)) {
          if (process.platform === 'win32' && fallbackIsShell && cachedAgentForeground !== null) {
            // Job, not console: "is anything besides the shell alive?" needs no
            // console attachment, so it needs no forked helper (#10857).
            const paneProcessIds = readWindowsPtyJobProcessIds(proc)
            // Unverifiable is never exit proof (ssh-execution-boundary.md): hold.
            if (paneProcessIds === null) {
              return
            }
            // A superset answer is not proof of life -- a WSL pane keeps
            // console-detached plumbing in its job, so `size > 1` stays true
            // forever and used to veto retirement outright. That pinned a dead
            // agent's name (#9258's bug, new mechanism) and, because a non-null
            // cache makes idleNoEvidenceShell false, pinned the refresh at 1s
            // and defeated the 15s idle backoff. Let age settle it instead.
            retireStaleForegroundIdentity({ onlyWhenAged: paneProcessIds.size > 1 })
            return
          }
          retireStaleForegroundIdentity()
          return
        }
        cachedAgentForeground = { processName, refreshedAt: Date.now() }
        startupAgentForeground = null
        return processName
      })
      .catch(() => {
        // Best-effort only: foreground enrichment must never affect PTY health.
      })
      .finally(() => {
        foregroundRefreshInFlight = false
      })
  }

  return {
    recordOutput: (data) => {
      if (data.length > 0) {
        lastOutputAt = Date.now()
      }
    },
    markDead: () => {
      cachedAgentForeground = null
      startupAgentForeground = null
    },
    getForegroundProcess: () => {
      if (args.isDead()) {
        return null
      }
      try {
        const fallbackProcess = getFallbackProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        const inspectOuterWrapper =
          fallbackRecognition !== null &&
          shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)
        if (fallbackProcess && fallbackRecognition && !inspectOuterWrapper) {
          cachedAgentForeground = { processName: fallbackProcess, refreshedAt: Date.now() }
          startupAgentForeground = null
          return fallbackProcess
        }
        scheduleRefresh(fallbackProcess)
        const now = Date.now()
        if (
          cachedAgentForeground &&
          now - cachedAgentForeground.refreshedAt <= FOREGROUND_AGENT_CACHE_TTL_MS
        ) {
          return cachedAgentForeground.processName
        }
        if (
          cachedAgentForeground &&
          fallbackProcess !== null &&
          (isAgentForegroundWrapperProcess(fallbackProcess) ||
            inspectOuterWrapper ||
            (process.platform === 'win32' && isShellProcess(fallbackProcess)))
        ) {
          return cachedAgentForeground.processName
        }
        const activeStartupAgentForeground = getActiveStartupAgent(now)
        if (fallbackProcess && isShellProcess(fallbackProcess) && activeStartupAgentForeground) {
          return activeStartupAgentForeground.processName
        }
        return fallbackProcess
      } catch {
        return null
      }
    },
    confirmForegroundProcess: async () => {
      if (args.isDead() || !proc.pid) {
        return null
      }
      try {
        const fallbackProcess = getFallbackProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        if (
          !fallbackProcess ||
          (fallbackRecognition !== null &&
            process.platform !== 'win32' &&
            !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
          (process.platform !== 'win32' && !shouldInspectFallback(fallbackProcess))
        ) {
          return fallbackProcess
        }
        const resolution = await resolveAgentForegroundProcessWithAvailability(
          proc.pid,
          fallbackProcess,
          {
            contextPaths,
            fresh: true,
            ...(process.platform === 'win32'
              ? {
                  forceProcessScan: true,
                  readWindowsConsoleAttachedProcessIds: () =>
                    readWindowsConsoleAttachedProcessIds(proc.pid)
                }
              : {})
          }
        )
        if (args.isDead() || !resolution.available) {
          return null
        }
        const recognized = recognizeAgentProcess(resolution.processName)
        if (recognized) {
          cachedAgentForeground = {
            processName: recognized.processName,
            refreshedAt: Date.now()
          }
          startupAgentForeground = null
          return recognized.processName
        }
        cachedAgentForeground = null
        startupAgentForeground = null
        return resolution.processName
      } catch {
        return null
      }
    }
  }
}

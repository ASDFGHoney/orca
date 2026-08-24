export type PtyProcessInspectionSource = {
  getForegroundProcess(ptyId: string): Promise<string | null>
  inspectProcess?: (ptyId: string) => Promise<{
    foregroundProcess: string | null
    hasChildProcesses: boolean
    unavailable?: true
  }>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
}

export type PtyProcessLivenessEvidence =
  | {
      status: 'live'
      foregroundProcess: string | null
      hasChildProcesses: boolean | null
    }
  | { status: 'unverifiable'; reason: string }
  | { status: 'exited' }

type PtyProcessEvidenceEntry = {
  source: PtyProcessInspectionSource
  identity: string
  freshness: number
  owningInventoryObservedPty: boolean
  failureCount: number
  evidence: PtyProcessLivenessEvidence | null
  expiresAt: number
  timedOut: boolean
  probe: Promise<PtyProcessLivenessEvidence> | null
}

export type PtyProcessLivenessBrokerOptions = {
  timeoutMs: number
  liveTtlMs?: number
  unavailableBackoffBaseMs?: number
  unavailableBackoffMaxMs?: number
  now?: () => number
  onInspectionError?: (ptyId: string, error: unknown) => void
}

const DEFAULT_LIVE_TTL_MS = 10_000
const DEFAULT_UNAVAILABLE_BACKOFF_BASE_MS = 3_000
const DEFAULT_UNAVAILABLE_BACKOFF_MAX_MS = 30_000

export class PtyProcessLivenessBroker {
  private readonly entries = new Map<string, PtyProcessEvidenceEntry>()
  private readonly now: () => number

  constructor(private readonly options: PtyProcessLivenessBrokerOptions) {
    this.now = options.now ?? Date.now
  }

  inspect(args: {
    source: PtyProcessInspectionSource
    ptyId: string
    identity: string
    freshness?: number
    reuseSettled?: boolean
    deadline?: number
    waitForSettlement?: boolean
    owningInventoryObservedPty?: boolean
  }): Promise<PtyProcessLivenessEvidence> {
    const freshness = args.freshness ?? 0
    const waitMs = args.waitForSettlement
      ? null
      : Math.max(
          0,
          Math.min(
            this.options.timeoutMs,
            args.deadline === undefined ? this.options.timeoutMs : args.deadline - this.now()
          )
        )
    const existing = this.entries.get(args.ptyId)
    if (
      existing?.source === args.source &&
      existing.identity === args.identity &&
      args.owningInventoryObservedPty === true
    ) {
      existing.owningInventoryObservedPty = true
      if (existing.evidence?.status === 'exited') {
        this.storeUnverifiable(existing, 'owning inventory re-observed PTY')
      }
    }
    if (
      existing?.source === args.source &&
      existing.identity === args.identity &&
      existing.probe &&
      existing.freshness < freshness
    ) {
      if (waitMs === 0) {
        return Promise.resolve({
          status: 'unverifiable',
          reason: 'process inspection timed out'
        })
      }
      return this.waitForProbe(args.ptyId, existing, waitMs).then(() =>
        existing.probe
          ? { status: 'unverifiable', reason: 'process inspection timed out' }
          : this.inspect(args)
      )
    }
    if (
      existing?.source === args.source &&
      existing.identity === args.identity &&
      existing.freshness >= freshness
    ) {
      if (existing.probe) {
        return !args.waitForSettlement && existing.timedOut
          ? Promise.resolve({ status: 'unverifiable', reason: 'process inspection timed out' })
          : waitMs === 0
            ? Promise.resolve({
                status: 'unverifiable',
                reason: 'process inspection timed out'
              })
            : this.waitForProbe(args.ptyId, existing, waitMs)
      }
      if (args.reuseSettled !== false && existing.evidence && existing.expiresAt > this.now()) {
        return Promise.resolve(existing.evidence)
      }
    }
    if (waitMs === 0) {
      return Promise.resolve({ status: 'unverifiable', reason: 'process inspection timed out' })
    }

    const failureCount =
      existing?.source === args.source && existing.identity === args.identity
        ? existing.failureCount
        : 0
    const entry: PtyProcessEvidenceEntry = {
      source: args.source,
      identity: args.identity,
      freshness,
      owningInventoryObservedPty: args.owningInventoryObservedPty === true,
      failureCount,
      evidence: null,
      expiresAt: 0,
      timedOut: false,
      probe: null
    }
    const probe = this.runProbe(args.source, args.ptyId)
      .then((evidence) => {
        const reconciled =
          evidence.status === 'exited' && entry.owningInventoryObservedPty
            ? {
                status: 'unverifiable' as const,
                reason: 'owning inventory re-observed PTY'
              }
            : evidence
        if (this.entries.get(args.ptyId) !== entry) {
          return reconciled
        }
        entry.probe = null
        entry.timedOut = false
        entry.evidence = reconciled
        if (reconciled.status === 'unverifiable') {
          entry.failureCount += 1
          entry.expiresAt = this.now() + this.unavailableBackoffMs(entry.failureCount)
        } else if (reconciled.status === 'live') {
          entry.failureCount = 0
          entry.expiresAt = this.now() + (this.options.liveTtlMs ?? DEFAULT_LIVE_TTL_MS)
        } else {
          entry.failureCount = 0
          entry.expiresAt = Number.POSITIVE_INFINITY
        }
        return reconciled
      })
      .catch((error): PtyProcessLivenessEvidence => {
        if (this.entries.get(args.ptyId) === entry) {
          entry.probe = null
          entry.timedOut = false
          entry.failureCount += 1
          entry.evidence = { status: 'unverifiable', reason: describeError(error) }
          entry.expiresAt = this.now() + this.unavailableBackoffMs(entry.failureCount)
        }
        try {
          this.options.onInspectionError?.(args.ptyId, error)
        } catch {
          // Diagnostic observers cannot change the authority verdict.
        }
        return { status: 'unverifiable', reason: describeError(error) }
      })
    entry.probe = probe
    this.entries.set(args.ptyId, entry)
    return this.waitForProbe(args.ptyId, entry, waitMs)
  }

  invalidate(ptyId: string): void {
    this.entries.delete(ptyId)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  getPendingCount(): number {
    let count = 0
    for (const entry of this.entries.values()) {
      if (entry.probe) {
        count += 1
      }
    }
    return count
  }

  private async runProbe(
    source: PtyProcessInspectionSource,
    ptyId: string
  ): Promise<PtyProcessLivenessEvidence> {
    try {
      if (source.inspectProcess) {
        const inspection = await source.inspectProcess(ptyId)
        return inspection.unavailable
          ? { status: 'unverifiable', reason: 'process inspection unavailable' }
          : {
              status: 'live',
              foregroundProcess: inspection.foregroundProcess,
              hasChildProcesses: inspection.hasChildProcesses
            }
      }
      const foregroundProcess = await source.getForegroundProcess(ptyId)
      return {
        status: 'live',
        foregroundProcess,
        hasChildProcesses: source.hasChildProcesses ? await source.hasChildProcesses(ptyId) : null
      }
    } catch (error) {
      if (isTerminalGoneError(error)) {
        return { status: 'exited' }
      }
      throw error
    }
  }

  private waitForProbe(
    ptyId: string,
    entry: PtyProcessEvidenceEntry,
    timeoutMs: number | null
  ): Promise<PtyProcessLivenessEvidence> {
    const probe = entry.probe
    if (!probe) {
      return Promise.resolve(
        entry.evidence ?? { status: 'unverifiable', reason: 'process inspection unavailable' }
      )
    }
    if (timeoutMs === null) {
      return probe
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.entries.get(ptyId) === entry && entry.probe === probe) {
          entry.timedOut = true
        }
        resolve({ status: 'unverifiable', reason: 'process inspection timed out' })
      }, timeoutMs)
      void probe.then((evidence) => {
        clearTimeout(timeout)
        resolve(evidence)
      })
    })
  }

  private unavailableBackoffMs(failureCount: number): number {
    const base = this.options.unavailableBackoffBaseMs ?? DEFAULT_UNAVAILABLE_BACKOFF_BASE_MS
    const max = this.options.unavailableBackoffMaxMs ?? DEFAULT_UNAVAILABLE_BACKOFF_MAX_MS
    return Math.min(max, base * 2 ** Math.max(0, failureCount - 1))
  }

  private storeUnverifiable(entry: PtyProcessEvidenceEntry, reason: string): void {
    entry.failureCount += 1
    entry.evidence = { status: 'unverifiable', reason }
    entry.expiresAt = this.now() + this.unavailableBackoffMs(entry.failureCount)
  }
}

function isTerminalGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  return message === 'terminal_gone' || code === 'terminal_gone'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Deadline for one retirement discovery scan. Generated create awaits it, so it has to be short
 *  enough that a stalled NFS/SMB/WSL listing degrades to "seed nothing" instead of a frozen create. */
export const RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS = 15_000

/** How long a failed scan stays failed, so a stalled mount is not re-probed on every create. */
export const RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS = 60_000

/** Listings this module may leave outstanding at once, process-wide.
 *
 *  The deadline above abandons a scan, it cannot cancel one: an unabortable `readdir` keeps its
 *  libuv threadpool thread until the OS releases it, and that pool defaults to four. So the
 *  backoff alone only paces the leak — each lapse still stacks another stuck thread. This bounds
 *  what retirement discovery can hold; it is not a guarantee the pool stays healthy, since the WSL
 *  gate and its close lane hold threads of their own. Two leaves headroom for both. */
export const RETIREMENT_BACKFILL_MAX_OUTSTANDING_SCANS = 2

type BackfillScan = {
  /** Resolves with the discovered names, or rejects once the deadline lapses. */
  names: Promise<Set<string>>
  /** Epoch ms this scan may be retried after; 0 while it is in flight or has succeeded. */
  retryAfter: number
}

const scansByStore = new WeakMap<object, Map<string, BackfillScan>>()

/** Process-wide on purpose: the threadpool these listings occupy is process-wide too. */
let outstandingScans = 0

export function getOutstandingRetirementBackfillScanCount(): number {
  return outstandingScans
}

/** A test that stalls a scan can never settle it, so the counter would leak into the next test. */
export function resetRetirementBackfillScanStateForTests(): void {
  outstandingScans = 0
}

function withScanDeadline(scan: Promise<Set<string>>): Promise<Set<string>> {
  return new Promise<Set<string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`retirement backfill scan exceeded ${RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS}ms`)
      )
    }, RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    timer.unref?.()
    void scan.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Memoizes the one-time retirement discovery scan per store and cwd namespace.
 *
 *  A success is kept for the process lifetime — a name never un-spends, so rescanning could only
 *  lose entries. A failure is not: the original cache held the scan Promise forever and its
 *  `readdir` had no deadline, so one stalled listing wedged this create and every later
 *  generated-name create for the namespace until Orca restarted.
 *
 *  Retrying a failure is therefore allowed, but only up to
 *  `RETIREMENT_BACKFILL_MAX_OUTSTANDING_SCANS` listings still stuck in the kernel at once. */
export function runRetirementBackfillScan(
  store: object,
  scanKey: string,
  scan: () => Promise<Set<string>>
): Promise<Set<string>> {
  let storeScans = scansByStore.get(store)
  if (!storeScans) {
    storeScans = new Map()
    scansByStore.set(store, storeScans)
  }
  const cached = storeScans.get(scanKey)
  if (cached && (cached.retryAfter === 0 || Date.now() < cached.retryAfter)) {
    return cached.names
  }
  if (outstandingScans >= RETIREMENT_BACKFILL_MAX_OUTSTANDING_SCANS) {
    // Deliberately not memoized: this namespace never got to start a listing, so arming its
    // backoff would spread one wedged mount's outage to repos on healthy disks. Rejecting costs
    // nothing, so the next create can just try again once a slot frees.
    return Promise.reject(
      new Error(
        `retirement backfill scan deferred: ${outstandingScans} listings already outstanding`
      )
    )
  }
  const entry: BackfillScan = { names: Promise.resolve(new Set()), retryAfter: 0 }
  const started = scan()
  outstandingScans += 1
  void started.then(
    (names) => {
      outstandingScans -= 1
      // A listing that lands after the deadline still holds the right answer, and under WSL gate
      // contention that is the common case rather than the edge one — the gate admits a single
      // scan at a time and gives it 60s, four times this deadline. Dropping it would leave the
      // namespace unseeded on exactly the mounts this feature exists to cover.
      if (entry.retryAfter !== 0) {
        entry.names = Promise.resolve(names)
        entry.retryAfter = 0
      }
    },
    () => {
      outstandingScans -= 1
    }
  )
  entry.names = withScanDeadline(started).catch((error: unknown) => {
    entry.retryAfter = Date.now() + RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS
    throw error
  })
  storeScans.set(scanKey, entry)
  return entry.names
}

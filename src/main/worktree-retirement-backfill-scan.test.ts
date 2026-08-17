import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RETIREMENT_BACKFILL_MAX_OUTSTANDING_SCANS,
  RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS,
  RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS,
  getOutstandingRetirementBackfillScanCount,
  resetRetirementBackfillScanStateForTests,
  runRetirementBackfillScan
} from './worktree-retirement-backfill-scan'

/** A scan the test settles by hand, standing in for a `readdir` on a stalled NFS/SMB/WSL mount. */
function stallingScan(): { run: () => Promise<Set<string>>; finish: (names: string[]) => void } {
  let settle: (names: Set<string>) => void = () => {}
  return {
    run: () => new Promise<Set<string>>((resolve) => (settle = resolve)),
    finish: (names) => settle(new Set(names))
  }
}

describe('runRetirementBackfillScan', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // A stalled scan is never settled by the test that started it, so its slot would leak forward.
    resetRetirementBackfillScanStateForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a listing that never returns instead of blocking create forever', async () => {
    const scan = stallingScan()

    const names = runRetirementBackfillScan({}, 'ns', scan.run)
    const settled = expect(names).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)

    await settled
  })

  it('retries a timed-out namespace once its backoff lapses, rather than wedging until restart', async () => {
    const store = {}
    const first = stallingScan()
    const second = vi.fn(async () => new Set(['nautilus']))

    const stalled = runRetirementBackfillScan(store, 'ns', first.run)
    const settled = expect(stalled).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    await settled

    // Why the backoff: an unabortable `readdir` still holds a libuv thread, so re-probing on every
    // create would starve the pool. Until it lapses the failure is served from the memo.
    await expect(runRetirementBackfillScan(store, 'ns', second)).rejects.toThrow(/exceeded/)
    expect(second).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS)
    await expect(runRetirementBackfillScan(store, 'ns', second)).resolves.toEqual(
      new Set(['nautilus'])
    )
  })

  it('scans a namespace once and shares the answer with every later caller', async () => {
    const store = {}
    const scan = vi.fn(async () => new Set(['nautilus']))

    await expect(runRetirementBackfillScan(store, 'ns', scan)).resolves.toEqual(
      new Set(['nautilus'])
    )
    await expect(runRetirementBackfillScan(store, 'ns', scan)).resolves.toEqual(
      new Set(['nautilus'])
    )

    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('keeps one namespace stall from failing another', async () => {
    const store = {}
    const stuck = stallingScan()
    const healthy = vi.fn(async () => new Set(['nautilus']))

    const stalled = runRetirementBackfillScan(store, 'stuck-ns', stuck.run)
    const settled = expect(stalled).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    await settled

    await expect(runRetirementBackfillScan(store, 'healthy-ns', healthy)).resolves.toEqual(
      new Set(['nautilus'])
    )
  })

  it('keeps a listing that lands after the deadline instead of discarding the answer', async () => {
    // The WSL gate admits one scan at a time and allows it 60s — four times this deadline — so a
    // late-but-correct listing is the normal case there, not an edge case.
    const store = {}
    const slow = stallingScan()
    const rescan = vi.fn(async () => new Set(['orca']))

    const pending = runRetirementBackfillScan(store, 'ns', slow.run)
    const settled = expect(pending).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    await settled

    slow.finish(['nautilus'])
    await vi.advanceTimersByTimeAsync(0)

    await expect(runRetirementBackfillScan(store, 'ns', rescan)).resolves.toEqual(
      new Set(['nautilus'])
    )
    expect(rescan).not.toHaveBeenCalled()
  })

  it('does not arm a backoff on a namespace it never got to scan', async () => {
    // A deferred namespace never touched the wedged mount; penalising it would spread one bad
    // mount's outage to repos on healthy disks.
    const stalls = Array.from({ length: RETIREMENT_BACKFILL_MAX_OUTSTANDING_SCANS }, stallingScan)
    for (const [index, stall] of stalls.entries()) {
      const pending = runRetirementBackfillScan({}, `ns-${index}`, stall.run)
      const settled = expect(pending).rejects.toThrow(/exceeded/)
      await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
      await settled
    }

    const store = {}
    const healthy = vi.fn(async () => new Set(['nautilus']))
    await expect(runRetirementBackfillScan(store, 'ns-healthy', healthy)).rejects.toThrow(
      /deferred/
    )

    // A slot frees, and the very next create succeeds — no backoff to wait out.
    stalls[0].finish([])
    await vi.advanceTimersByTimeAsync(0)
    await expect(runRetirementBackfillScan(store, 'ns-healthy', healthy)).resolves.toEqual(
      new Set(['nautilus'])
    )
  })

  it('stops stacking listings once the abandoned ones reach the cap', async () => {
    // The deadline abandons a listing, it cannot cancel one. Without a cap every lapsed backoff
    // stacks another stuck `readdir` on the same wedged mount until the libuv pool is starved.
    const stalls = Array.from({ length: RETIREMENT_BACKFILL_MAX_OUTSTANDING_SCANS }, stallingScan)
    for (const [index, stall] of stalls.entries()) {
      const pending = runRetirementBackfillScan({}, `ns-${index}`, stall.run)
      const settled = expect(pending).rejects.toThrow(/exceeded/)
      await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
      await settled
    }
    expect(getOutstandingRetirementBackfillScanCount()).toBe(
      RETIREMENT_BACKFILL_MAX_OUTSTANDING_SCANS
    )

    const overflow = vi.fn(async () => new Set(['nautilus']))
    await expect(runRetirementBackfillScan({}, 'ns-overflow', overflow)).rejects.toThrow(/deferred/)
    expect(overflow).not.toHaveBeenCalled()
    expect(getOutstandingRetirementBackfillScanCount()).toBe(
      RETIREMENT_BACKFILL_MAX_OUTSTANDING_SCANS
    )
  })

  it('frees the slot when an abandoned listing finally settles, so scanning resumes', async () => {
    const stalls = Array.from({ length: RETIREMENT_BACKFILL_MAX_OUTSTANDING_SCANS }, stallingScan)
    for (const [index, stall] of stalls.entries()) {
      const pending = runRetirementBackfillScan({}, `ns-${index}`, stall.run)
      const settled = expect(pending).rejects.toThrow(/exceeded/)
      await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
      await settled
    }

    // The mount comes back and the kernel releases the abandoned call.
    stalls[0].finish([])
    await vi.advanceTimersByTimeAsync(0)

    const recovered = vi.fn(async () => new Set(['nautilus']))
    await expect(runRetirementBackfillScan({}, 'ns-recovered', recovered)).resolves.toEqual(
      new Set(['nautilus'])
    )
  })

  it('does not let one store inherit another store scan memo', async () => {
    const first = vi.fn(async () => new Set(['nautilus']))
    const second = vi.fn(async () => new Set(['orca']))

    await runRetirementBackfillScan({}, 'ns', first)
    await expect(runRetirementBackfillScan({}, 'ns', second)).resolves.toEqual(new Set(['orca']))
  })
})

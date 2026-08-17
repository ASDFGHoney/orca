/**
 * Names the driver of a store-write chain headed for React #185.
 *
 * react-dom counts nested sync commits in a module-level counter keyed on the
 * root, so the #185 throw lands on whichever fiber calls setState next — the
 * blamed component stack is an innocent bystander (#11326). Field reports
 * therefore never name the loop. This wrapper counts consecutive app-store
 * writes within one synchronous run and, just below React's limit, captures
 * the dispatching call path into a crash breadcrumb — evidence recorded
 * BEFORE the throw, naming the ring member that actually drives it.
 *
 * "Same flush" = one synchronous stack run, delimited by microtask drain: the
 * first write of a burst queues a pre-bound microtask that zeroes the depth.
 * Microtasks only run once the JS stack empties, and React's sync work loop —
 * the loop whose commits feed the nested-update counter toward the throw —
 * never empties the stack mid-chain (commit, layout effects, and the
 * commit-time passive-effect flush all run inside one do/while). So any
 * #185-bound cascade of store writes is contained in one burst, while writes
 * separated by an await or task boundary reset: React drains its own
 * microtask-scheduled sync work first, which is a genuine yield.
 *
 * Patch point mirrors store-listener-census: the inner api is only reachable
 * as the state creator's third argument. Unlike subscribe, slices close over
 * `set` (the first creator argument) at creation, so the caller must also
 * rebind that argument to the patched api.setState — see store/index.ts.
 *
 * Cost on the normal path (every store write, ~2.4k live subscriptions): one
 * integer increment, two branch checks, and — once per burst — queueing a
 * pre-bound microtask. No allocation, no stack capture. `new Error().stack`
 * is only constructed after the threshold is crossed, at most once per burst
 * and once per STORE_WRITE_CHAIN_CAPTURE_INTERVAL_MS.
 *
 * Diagnostic only: observes and records, never throttles or suppresses a
 * write. Store-driven rings are the surviving field hypothesis; a ring cycling
 * purely through React state never touches this counter and stays invisible.
 */
import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'
import { STORE_WRITE_CHAIN_BREADCRUMB } from '../../../shared/store-write-chain-diagnostics'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

/** react-dom 19.2.x nested commit limit. */
const REACT_NESTED_UPDATE_LIMIT = 50
/** Writes-in-one-flush that trip capture (40). Below the React limit so the
 *  evidence lands before React throws; a ring commits at least once per store
 *  write it chains, so write depth 40 precedes commit 50. */
export const STORE_WRITE_CHAIN_STACK_THRESHOLD = REACT_NESTED_UPDATE_LIMIT - 10
/** Frame budget for the capture: enough to reach through wrapper and notify
 *  frames into the ring; V8's default 10 would show mostly plumbing. */
const CAPTURE_STACK_FRAMES = 40
/** Renderer-side floor between captures. A sustained sub-limit oscillation
 *  re-crosses the threshold every frame; this bounds stack + IPC cost while
 *  main-process coalescing separately bounds ring slots. Skipped bursts stay
 *  countable via burstsSinceInstall deltas between captured crumbs. */
export const STORE_WRITE_CHAIN_CAPTURE_INTERVAL_MS = 10_000

type StoreWriteChainTelemetryOptions = {
  threshold?: number
  captureIntervalMs?: number
  /** Monotonic clock; wall-clock jumps must not stretch the capture floor. */
  now?: () => number
  captureStack?: () => string | undefined
  record?: (name: string, data: CrashReportBreadcrumbData) => void
}

/** Only called past the threshold — never on the normal write path. */
function captureDispatchStack(): string | undefined {
  const previousLimit = Error.stackTraceLimit
  try {
    Error.stackTraceLimit = CAPTURE_STACK_FRAMES
    return new Error('store write chain depth').stack
  } finally {
    Error.stackTraceLimit = previousLimit
  }
}

/** Call once from inside the store's state creator, passing its `api`
 *  argument; then rebind the creator's `set` argument to api.setState so
 *  slice-action writes are counted too. */
export function installStoreWriteChainTelemetry<TSetState extends (...args: never[]) => unknown>(
  api: { setState: TSetState },
  options?: StoreWriteChainTelemetryOptions
): void {
  try {
    const originalSetState = api.setState
    if (typeof originalSetState !== 'function') {
      return
    }
    const threshold = options?.threshold ?? STORE_WRITE_CHAIN_STACK_THRESHOLD
    const captureIntervalMs = options?.captureIntervalMs ?? STORE_WRITE_CHAIN_CAPTURE_INTERVAL_MS
    const now = options?.now ?? ((): number => performance.now())
    const captureStack = options?.captureStack ?? captureDispatchStack
    const record = options?.record ?? recordRendererCrashBreadcrumb

    let depth = 0
    let resetQueued = false
    let burstsSinceInstall = 0
    let lastCaptureAtMs = Number.NEGATIVE_INFINITY

    const resetDepth = (): void => {
      depth = 0
      resetQueued = false
    }

    // Fixed arity on purpose: a rest parameter would allocate an args array on
    // every store write. zustand's setState takes (partial, replace).
    api.setState = ((partial: Parameters<TSetState>[0], replace: Parameters<TSetState>[1]) => {
      depth += 1
      if (!resetQueued) {
        resetQueued = true
        queueMicrotask(resetDepth)
      }
      // Strict equality latches capture to the crossing write: a chain running
      // deeper than the threshold still costs one capture per burst.
      if (depth === threshold) {
        try {
          burstsSinceInstall += 1
          const nowMs = now()
          if (nowMs - lastCaptureAtMs >= captureIntervalMs) {
            lastCaptureAtMs = nowMs
            const stack = captureStack()
            record(STORE_WRITE_CHAIN_BREADCRUMB, {
              depth,
              burstsSinceInstall,
              ...(stack ? { stack } : {})
            })
          }
        } catch {
          // Diagnostic only; a capture failure must never block the write.
        }
      }
      return originalSetState(partial, replace)
    }) as TSetState
  } catch {
    // Best-effort instrumentation; the store must work without it.
  }
}

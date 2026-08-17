/**
 * Names the driver of a store-write chain headed for React #185.
 *
 * react-dom counts nested sync commits in a module-level counter keyed on the
 * root, so the #185 throw lands on whichever fiber calls setState next — the
 * blamed component stack is an innocent bystander (#11326). Field reports
 * therefore never name the loop. This wrapper counts consecutive zustand
 * store writes within one synchronous run and, below React's limit, captures
 * the dispatching call path into a crash breadcrumb — evidence recorded
 * BEFORE the throw, naming the ring member that actually drives it.
 *
 * Scope: every renderer zustand store shares ONE counter and capture budget —
 * useAppStore plus the standalone stores (running-terminal-close-confirm,
 * plugin-panels, plugin-language-packs) — because a cascade can cross stores,
 * and per-store counters would each idle under the threshold while the
 * combined chain sails past it. NOT covered: rings cycling purely through
 * React component state, and subscriptions built directly on
 * useSyncExternalStore over non-zustand sources. An absent breadcrumb rules
 * out zustand-write-driven rings only; it does not exonerate those classes.
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
/** Writes-in-one-flush that trip capture (25). Commits reach React's limit no
 *  LATER than writes do — every write commits, and a mixed ring adds
 *  component-state commits between writes — so the margin must budget those
 *  non-store hops. When write T dispatches, a ring with k non-store commits
 *  per store write has ~(1+k)·(T−1) commits behind it; the evidence lands
 *  before the throw iff that stays ≤ 50. T=25 tolerates k=1 (2·24 = 48): a
 *  ring alternating one store write with one component-state hop is still
 *  captured, where T=40 required k=0 (2·39 = 78 overshoots — only ~11
 *  non-store commits TOTAL fit in its margin). Rings with k≥2 still throw
 *  uncaptured. Cost of the wider net: benign 25–39-write bursts capture too,
 *  bounded to one name-only crumb per capture interval (and one ring slot per
 *  30s by main-process coalescing); their depth/burst fields keep them
 *  tellable from true rings. */
export const STORE_WRITE_CHAIN_STACK_THRESHOLD = REACT_NESTED_UPDATE_LIMIT / 2
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

type StoreWriteChainTelemetry = {
  /** Call from inside a store's state creator, passing its `api` argument;
   *  then rebind the creator's `set` argument to api.setState so slice/action
   *  writes are counted too. */
  install: <TSetState extends (...args: never[]) => unknown>(api: { setState: TSetState }) => void
}

/** One depth counter, burst latch, and capture floor shared by every store
 *  this tracker is installed on: a flush is a property of the JS stack, not
 *  of any one store, so a cross-store cascade sums here. */
export function createStoreWriteChainTelemetry(
  options?: StoreWriteChainTelemetryOptions
): StoreWriteChainTelemetry {
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

  return {
    install: <TSetState extends (...args: never[]) => unknown>(api: {
      setState: TSetState
    }): void => {
      try {
        const originalSetState = api.setState
        if (typeof originalSetState !== 'function') {
          return
        }
        // Fixed arity on purpose: a rest parameter would allocate an args array
        // on every store write. zustand's setState takes (partial, replace).
        api.setState = ((partial: Parameters<TSetState>[0], replace: Parameters<TSetState>[1]) => {
          depth += 1
          if (!resetQueued) {
            resetQueued = true
            queueMicrotask(resetDepth)
          }
          // Strict equality latches capture to the crossing write: a chain
          // running deeper than the threshold still costs one capture per
          // burst, no matter which stores its writes land on.
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
  }
}

/** Isolated tracker per call — unit-test convenience; production stores must
 *  share `installSharedStoreWriteChainTelemetry` or cross-store cascades
 *  split across counters and never trip. */
export function installStoreWriteChainTelemetry<TSetState extends (...args: never[]) => unknown>(
  api: { setState: TSetState },
  options?: StoreWriteChainTelemetryOptions
): void {
  createStoreWriteChainTelemetry(options).install(api)
}

const sharedStoreWriteChainTelemetry = createStoreWriteChainTelemetry()

/** The production installer: every zustand store (see Scope above) passes its
 *  creator `api` here so one counter sees the whole flush. */
export const installSharedStoreWriteChainTelemetry = sharedStoreWriteChainTelemetry.install

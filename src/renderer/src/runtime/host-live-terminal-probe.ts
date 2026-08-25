import type { RuntimeTerminalListResult } from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

/**
 * Asks the host whether ANY terminal is live in an environment, for the one
 * question the session-tab mirror cannot answer: a live host that has not
 * published yet returns the same empty inventory as a host with no terminals
 * at all. `terminal.list` reads the PTY controller — `ptysById` plus the
 * cross-generation daemon inventory — not the mirror, so it sees exactly that
 * gap.
 *
 * `unverifiable` is a verdict, never a synonym for `none`: loss of contact
 * with the execution host is no evidence a host-owned PTY exited.
 */
export type HostLiveTerminalProbeVerdict = 'live' | 'none' | 'unverifiable'

type RuntimeCall = (args: {
  selector: string
  method: string
  params: unknown
  timeoutMs: number
}) => Promise<RuntimeRpcResponse<unknown>>

const inFlightProbeByEnvironment = new Map<string, Promise<HostLiveTerminalProbeVerdict>>()

function isTerminalListResult(value: unknown): value is RuntimeTerminalListResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { terminals?: unknown }).terminals)
  )
}

async function probeHost(
  environmentId: string,
  call: RuntimeCall
): Promise<HostLiveTerminalProbeVerdict> {
  const response = await call({
    selector: environmentId,
    method: 'terminal.list',
    params: {
      // Why: one row settles "any", and `totalCount` is the pre-limit census.
      limit: 1,
      // Why: without it an unavailable daemon inventory answers from stale PTY
      // records — a false empty. It raises `terminal_liveness_unavailable`
      // instead, which lands here as `unverifiable`.
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    },
    timeoutMs: 15_000
  })
  if (response.ok === false || !isTerminalListResult(response.result)) {
    return 'unverifiable'
  }
  const { terminals, totalCount } = response.result
  return terminals.length > 0 || (typeof totalCount === 'number' && totalCount > 0)
    ? 'live'
    : 'none'
}

export function probeHostLiveTerminals(
  environmentId: string,
  call: RuntimeCall = (args) => window.api.runtimeEnvironments.call(args)
): Promise<HostLiveTerminalProbeVerdict> {
  const existing = inFlightProbeByEnvironment.get(environmentId)
  if (existing) {
    return existing
  }
  const probe = probeHost(environmentId, call)
    .catch((): HostLiveTerminalProbeVerdict => 'unverifiable')
    .finally(() => {
      if (inFlightProbeByEnvironment.get(environmentId) === probe) {
        inFlightProbeByEnvironment.delete(environmentId)
      }
    })
  inFlightProbeByEnvironment.set(environmentId, probe)
  return probe
}

export function clearHostLiveTerminalProbesForTests(): void {
  inFlightProbeByEnvironment.clear()
}

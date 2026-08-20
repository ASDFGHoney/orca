import {
  getDaemonLaunchIdentity as inspectDaemonLaunchIdentity,
  type DaemonLaunchIdentity
} from './daemon-pid-identity'
import { getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from './types'
import {
  classifyLegacyDaemonSessionActivity,
  decideLegacyDaemonGenerationRetirement,
  type SessionActivityVerdict
} from './legacy-daemon-session-liveness'

export type LegacyGenerationRetirementAdapter = {
  protocolVersion: number
  listProcesses: (opts?: { deadlineMs?: number }) => Promise<
    {
      id: string
      agentSessionOwners?: readonly unknown[]
    }[]
  >
  inspectProcess: (id: string) => Promise<{
    foregroundProcess: string | null
    hasChildProcesses: boolean
    unavailable?: true
  }>
  disconnectOnly: () => Promise<void>
  shutdown?: (id: string, opts: { immediate?: boolean }) => Promise<void>
}

export type LegacyGenerationRetirementResult<T extends LegacyGenerationRetirementAdapter> = {
  kept: T[]
  retiredProtocolVersions: number[]
  leaks: { protocolVersion: number; reason: string }[]
}

export async function retireIdleLegacyDaemonGenerations<
  T extends LegacyGenerationRetirementAdapter
>(options: {
  adapters: readonly T[]
  runtimeDir: string
  currentEntryPath: string
  getDaemonLaunchIdentity?: (
    runtimeDir: string,
    socketPath: string,
    tokenPath: string,
    expectedEntryPath: string,
    protocolVersion?: number
  ) => Promise<DaemonLaunchIdentity>
}): Promise<LegacyGenerationRetirementResult<T>> {
  const kept: T[] = []
  const retiredProtocolVersions: number[] = []
  const leaks: { protocolVersion: number; reason: string }[] = []
  const resolveIdentity = options.getDaemonLaunchIdentity ?? inspectDaemonLaunchIdentity

  for (const adapter of options.adapters) {
    const outcome = await evaluateLegacyGeneration(adapter, {
      runtimeDir: options.runtimeDir,
      currentEntryPath: options.currentEntryPath,
      resolveIdentity
    })
    if (outcome.kind === 'retired') {
      retiredProtocolVersions.push(adapter.protocolVersion)
      continue
    }
    kept.push(adapter)
    if (outcome.leak) {
      leaks.push({ protocolVersion: adapter.protocolVersion, reason: outcome.leak })
    }
  }

  return { kept, retiredProtocolVersions, leaks }
}

async function evaluateLegacyGeneration<T extends LegacyGenerationRetirementAdapter>(
  adapter: T,
  options: {
    runtimeDir: string
    currentEntryPath: string
    resolveIdentity: (
      runtimeDir: string,
      socketPath: string,
      tokenPath: string,
      expectedEntryPath: string,
      protocolVersion?: number
    ) => Promise<DaemonLaunchIdentity>
  }
): Promise<{ kind: 'kept' | 'retired'; leak?: string }> {
  const identity = await options.resolveIdentity(
    options.runtimeDir,
    getDaemonSocketPath(options.runtimeDir, adapter.protocolVersion),
    getDaemonTokenPath(options.runtimeDir, adapter.protocolVersion),
    options.currentEntryPath,
    adapter.protocolVersion
  )
  if (identity !== 'match') {
    return { kind: 'kept' }
  }

  let sessions: { id: string; agentSessionOwners?: readonly unknown[] }[]
  try {
    sessions = await adapter.listProcesses()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warnLegacyGenerationLeak(adapter.protocolVersion, reason)
    return { kind: 'kept', leak: reason }
  }

  const verdicts: SessionActivityVerdict[] = []
  for (const session of sessions) {
    let inspection:
      | {
          foregroundProcess: string | null
          hasChildProcesses: boolean
          unavailable?: true
        }
      | { failed: true; reason: string }
    try {
      inspection = await adapter.inspectProcess(session.id)
    } catch (error) {
      inspection = {
        failed: true,
        reason: error instanceof Error ? error.message : String(error)
      }
    }
    verdicts.push(
      classifyLegacyDaemonSessionActivity({
        sessionId: session.id,
        agentSessionOwners: session.agentSessionOwners,
        inspection
      })
    )
  }

  const decision = decideLegacyDaemonGenerationRetirement(verdicts)
  if (decision.action === 'keep' && decision.reason === 'unverifiable') {
    warnLegacyGenerationLeak(adapter.protocolVersion, decision.leak)
    return { kind: 'kept', leak: decision.leak }
  }
  if (decision.action === 'keep') {
    return { kind: 'kept' }
  }

  // Idle shells can still be pane-bound; only an empty inventory is safe to retire.
  if (sessions.length > 0 || adapter.protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION) {
    return { kind: 'kept' }
  }

  try {
    await adapter.disconnectOnly()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warnLegacyGenerationLeak(adapter.protocolVersion, reason)
    return { kind: 'kept', leak: reason }
  }
  console.warn(`[daemon] Retired idle previous-generation daemon v${adapter.protocolVersion}`)
  return { kind: 'retired' }
}

function warnLegacyGenerationLeak(protocolVersion: number, reason: string): void {
  console.warn(`[daemon] Keeping previous-generation daemon v${protocolVersion}; ${reason}`)
}

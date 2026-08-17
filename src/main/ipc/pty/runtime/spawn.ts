import type { AgentSessionClaimedSpawnResult } from '../../../../shared/agent-session-host-authority'
import { rejectPaneSpawnReservation } from '../pane/spawn-reservation'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { adoptMaterializedRuntimePtySpawn } from './spawn-early'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { executeRuntimePtySpawn } from './spawn-execute'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'

function toRuntimeSpawnReply(result: {
  id: string
  incarnationId?: string
  wslDistro?: string | null
  stablePaneOwner?: { handle: string; tabId: string; leafId: string }
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
}) {
  return {
    id: result.id,
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...(typeof result.wslDistro === 'string' ? { wslDistro: result.wslDistro } : {}),
    ...(result.stablePaneOwner ? { stablePaneOwner: result.stablePaneOwner } : {}),
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
  }
}

export async function spawnPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
) {
  const ctx = createRuntimePtySpawnState(deps, args)
  const materialized = await adoptMaterializedRuntimePtySpawn(ctx)
  if (materialized) {
    return toRuntimeSpawnReply(materialized)
  }
  const earlyAdopt = await prepareRuntimePtySpawn(ctx)
  if (earlyAdopt) {
    return toRuntimeSpawnReply(earlyAdopt)
  }
  const earlyReserved = await buildRuntimePtySpawnOptions(ctx)
  if (earlyReserved) {
    return toRuntimeSpawnReply(earlyReserved)
  }
  try {
    await executeRuntimePtySpawn(ctx)
    return toRuntimeSpawnReply(await commitRuntimePtySpawn(ctx))
  } catch (err) {
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    // Why: once the reservation is created, any later throw — spawn
    // failure, persist failure, or a post-spawn helper such as
    // registerPty/rememberPaneKeyForPty/track — must settle it. Otherwise
    // it lingers in paneSpawnReservationsByOwnerKey and every future spawn
    // for this pane awaits a promise that never resolves. reject is a
    // no-op once the reservation has already resolved.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, err)
    throw err
  } finally {
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}

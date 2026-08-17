import { rejectPaneSpawnReservation } from '../pane/spawn-reservation'
import { beginPtyIpcSpawn } from './spawn-begin'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { executePtyIpcSpawn } from './spawn-execute'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

export async function runPtyIpcSpawn(deps: PtySpawnIpcDeps, args: PtySpawnIpcArgs) {
  const ctx = createPtyIpcSpawnState(deps, args)
  const early = await beginPtyIpcSpawn(ctx)
  if (early) {
    return early
  }
  try {
    await preparePtyIpcSpawnPreflight(ctx)
    await assemblePtyIpcSpawnEnv(ctx)
    await buildPtyIpcSpawnOptions(ctx)
    await executePtyIpcSpawn(ctx)
    return await commitPtyIpcSpawn(ctx)
  } catch (err) {
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    // Why: once the reservation is created, any later throw —
    // spawn failure, persist failure, or a post-spawn helper such as
    // seedHeadlessTerminal/registerPty/track — must settle it. Otherwise
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

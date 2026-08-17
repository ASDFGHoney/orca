import { ipcMain } from 'electron'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => {
    const startupPromise = getLocalPtyStartupPromise(args.connectionId)
    if (startupPromise) {
      await startupPromise
    }
    return runPtyIpcSpawn(deps, args)
  })
}

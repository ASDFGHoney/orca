import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PROCESS_ENTRY_FILENAME = 'wsl-transcript-fs-process-entry.js'

export function resolveWslTranscriptFsProcessEntryPath(
  moduleDir: string,
  resourcesPath: string | undefined = process.resourcesPath,
  pathExists: (path: string) => boolean = existsSync
): string {
  const unpackedModuleDir = moduleDir.includes('app.asar.unpacked')
    ? moduleDir
    : moduleDir.replace('app.asar', 'app.asar.unpacked')
  const adjacent = join(unpackedModuleDir, PROCESS_ENTRY_FILENAME)
  if (pathExists(adjacent)) {
    return adjacent
  }
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'app.asar.unpacked', 'out', 'main', PROCESS_ENTRY_FILENAME)
    if (pathExists(packaged)) {
      return packaged
    }
  }
  return join(process.cwd(), 'out', 'main', PROCESS_ENTRY_FILENAME)
}

export function forkWslTranscriptFsProcess(): ChildProcess {
  const entryPath = resolveWslTranscriptFsProcessEntryPath(__dirname)
  if (!existsSync(entryPath)) {
    throw new Error(`WSL transcript filesystem process entry not found: ${entryPath}`)
  }
  return fork(entryPath, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    ...(process.platform === 'win32' ? { windowsHide: true } : {})
  })
}

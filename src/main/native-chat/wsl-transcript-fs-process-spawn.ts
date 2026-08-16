import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PROCESS_ENTRY_FILENAME = 'wsl-transcript-fs-process-entry.js'

// Why: never `...process.env` into a forked transcript reader — an ambient
// NODE_OPTIONS would halt (--inspect-brk) or --require code into every child,
// and shell-exported secrets have no business in one. Mirrors the AI Vault
// service allowlist: only what Node/libuv need to start.
const FORK_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS'
] as const

export function wslTranscriptFsProcessForkEnv(
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const key of FORK_ENV_ALLOWLIST) {
    // Node folds Windows env-name case on access, so this also picks up `path`.
    const value = baseEnv[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

export function resolveWslTranscriptFsProcessEntryPath(
  moduleDir: string,
  resourcesPath: string | undefined = process.resourcesPath,
  pathExists: (path: string) => boolean = existsSync
): string {
  // Why: this module compiles into out/main or out/main/chunks, so probe both
  // levels. ELECTRON_RUN_AS_NODE children (the scanner service) bypass asar and
  // have no process.resourcesPath, so the __dirname legs must succeed there.
  const toUnpackedDir = (dir: string): string =>
    dir.replace(/([\\/])app\.asar(?=([\\/]|$))/, '$1app.asar.unpacked')
  for (const baseDir of [moduleDir, join(moduleDir, '..')].map(toUnpackedDir)) {
    const candidate = join(baseDir, PROCESS_ENTRY_FILENAME)
    if (pathExists(candidate)) {
      return candidate
    }
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
    env: wslTranscriptFsProcessForkEnv(),
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    ...(process.platform === 'win32' ? { windowsHide: true } : {})
  })
}

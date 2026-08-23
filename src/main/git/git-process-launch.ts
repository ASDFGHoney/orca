import {
  execNodeFileSync as execFileSync,
  spawnNodeProcess as spawn,
  type SpawnedProcess as ChildProcess,
  type SpawnedProcessOptions as SpawnOptions
} from '../../shared/child-process/node-process-execution'
import { recordSubprocessSpawn } from '../diagnostics/main-thread-churn-probe'
import { resolveCommand, prepareWindowsHostGitEnvironment } from './command-resolution'
import { resolveGitCommand } from './git-command-resolution'
import { createAbortError } from './subprocess-lifecycle'
import { untranslatedGitOutputEnv } from './git-environment-policy'

// Why: sync git blocks the main thread; a dead network drive can hang git for minutes without a timeout (issue #7225's 127s freeze).
const GIT_EXEC_SYNC_TIMEOUT_MS = 15_000

/**
 * Sync git command execution. Drop-in replacement for
 * `execFileSync('git', args, { cwd, encoding, ... })`.
 *
 * Returns trimmed stdout as a string.
 */
export function gitExecFileSync(
  args: string[],
  options: {
    cwd: string
    encoding?: BufferEncoding
    stdio?: SpawnOptions['stdio']
    timeout?: number
  }
): string {
  const resolved = resolveCommand('git', args, options.cwd)
  const spawnStartedAt = performance.now()
  try {
    return execFileSync(resolved.binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: options.encoding ?? 'utf-8',
      env: untranslatedGitOutputEnv(),
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout ?? GIT_EXEC_SYNC_TIMEOUT_MS,
      windowsHide: true
    }) as string
  } finally {
    // Sync exec blocks the main thread for its whole duration — the cost issue #7576 flags.
    recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  }
}

/**
 * Spawn a git child process. Drop-in replacement for
 * `spawn('git', args, { cwd, stdio, ... })`.
 */
type GitSpawnOptions = SpawnOptions & { cwd: string; wslDistro?: string }

export async function gitSpawnAfterWindowsEnvironmentReady(
  args: string[],
  options: GitSpawnOptions
): Promise<ChildProcess> {
  if (options.signal?.aborted) {
    throw createAbortError()
  }
  const resolved = resolveGitCommand(args, {
    cwd: options.cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.env ? { env: options.env } : {})
  })
  const env = await (prepareWindowsHostGitEnvironment(resolved, options.env, options.signal) ??
    options.env)
  if (options.signal?.aborted) {
    throw createAbortError()
  }
  return gitSpawn(args, env === options.env ? options : { ...options, env })
}

export function gitSpawn(args: string[], options: GitSpawnOptions): ChildProcess {
  const { wslDistro, ...spawnOptions } = options
  const resolved = resolveGitCommand(args, {
    cwd: options.cwd,
    ...(wslDistro ? { wslDistro } : {}),
    ...(spawnOptions.env ? { env: spawnOptions.env } : {})
  })
  const spawnStartedAt = performance.now()
  const child = spawn(resolved.binary, resolved.args, {
    ...spawnOptions,
    env: untranslatedGitOutputEnv(spawnOptions.env ?? process.env),
    windowsHide: true,
    cwd: resolved.cwd
  })
  recordSubprocessSpawn(resolved.binary, resolved.args, performance.now() - spawnStartedAt)
  return child
}

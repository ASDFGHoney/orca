/**
 * Centralized Git and generic command orchestration with transparent WSL support.
 *
 * Why: when a repo lives on a WSL filesystem, native Windows binaries (git.exe,
 * gh.exe, rg.exe) are absent or slow, so this routes execution through
 * `wsl.exe -d <distro>` with translated Linux paths.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { withGitSpan } from '../observability/instrumentation'
import { recordSubprocessSpawn } from '../diagnostics/main-thread-churn-probe'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { isWindowsBatchScript, resolveWindowsCommand } from '../win32-utils'
import {
  prepareWindowsHostGitEnvironment,
  resolveCommand,
  type ResolvedCommand
} from './command-resolution'
import {
  directWslGitExitCode,
  disableDirectWslGitAfterSuccessfulFallback,
  invalidateMissingDirectWslGit,
  resolveGitCommand,
  type GitExecOptions
} from './git-command-resolution'
import { execFileCapture } from './exec-file-capture'
import {
  buildNetworkSshPolicyEnv,
  nonInteractiveGitEnv,
  untranslatedGitOutputEnv
} from './git-environment-policy'
import {
  shouldRetryWindowsCommandShim,
  spawnCommandCapture,
  type CommandExecOptions
} from './spawn-command-capture'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting
} from './wsl-linked-worktree-git-routing'

export async function awaitWindowsHostGitEnvironmentReady(options: {
  cwd: string
  wslDistro?: string
  signal?: AbortSignal
}): Promise<void> {
  const resolved = resolveGitCommand(['--version'], options)
  await prepareWindowsHostGitEnvironment(resolved, undefined, options.signal)
}

/**
 * Async git command execution. Drop-in replacement for
 * `execFileAsync('git', args, { cwd, encoding, ... })`.
 */
export async function gitExecFileAsync(
  args: string[],
  options: GitExecOptions
): Promise<{ stdout: string; stderr: string }> {
  // Why: span the user-visible `git <subcommand>` form, not the resolved binary, so dashboards group by intent.
  return withGitSpan(
    { args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) },
    async () => {
      if (isWslLinkedWorktreeGitRoutingCandidate(options.cwd, options.wslDistro)) {
        await prepareWslLinkedWorktreeGitRouting(options.cwd, options.wslDistro, {
          signal: options.signal
        })
      }
      let resolved = resolveGitCommand(args, options)
      const environmentReady = prepareWindowsHostGitEnvironment(
        resolved,
        options.env,
        options.signal
      )
      const env = environmentReady ? await environmentReady : options.env
      const effectiveOptions = env === options.env ? options : { ...options, env }
      resolved = resolveGitCommand(args, effectiveOptions)
      const policy = effectiveOptions.useConfiguredSshCommandForNetwork
        ? await buildNetworkSshPolicyEnv(effectiveOptions)
        : { env: nonInteractiveGitEnv(effectiveOptions.env), mode: 'default' as const }
      const capture = (
        command: ResolvedCommand
      ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> =>
        execFileCapture(command.binary, command.args, {
          cwd: command.cwd,
          encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
          maxBuffer: options.maxBuffer,
          timeout: options.timeout,
          stdin: options.stdin,
          env: policy.env,
          signal: options.signal
        })
      let result: { stdout: string | Buffer; stderr: string | Buffer }
      try {
        result = await capture(resolved)
      } catch (error) {
        if (directWslGitExitCode(error, resolved) !== null && !options.signal?.aborted) {
          const wasMissing = invalidateMissingDirectWslGit(error, resolved)
          result = await capture(resolveGitCommand(args, effectiveOptions, true))
          // Why: matching failures can be normal Git control flow; only a successful login retry proves the direct environment was insufficient.
          disableDirectWslGitAfterSuccessfulFallback(wasMissing, resolved)
          const { stdout, stderr } = result
          return { stdout: stdout as string, stderr: stderr as string }
        }
        if (options.useConfiguredSshCommandForNetwork && error && typeof error === 'object') {
          Object.assign(error, { gitSshPolicyMode: policy.mode })
        }
        throw error
      }
      const { stdout, stderr } = result
      return { stdout: stdout as string, stderr: stderr as string }
    }
  )
}

/**
 * Async command execution with the same WSL cwd translation as repo-scoped git.
 * Keep this for fixed binary+argv call sites; never pass shell fragments.
 */
export async function commandExecFileAsync(
  command: string,
  args: string[],
  options: CommandExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const { wslDistro, ...execOptions } = options
  const resolved = resolveCommand(command, args, options.cwd, wslDistro)
  const binary =
    resolved.wsl === null ? resolveWindowsCommand(resolved.binary, options.env) : resolved.binary
  if (isWindowsBatchScript(binary)) {
    return spawnCommandCapture(binary, resolved.args, {
      ...execOptions,
      cwd: resolved.cwd
    })
  }
  try {
    const { stdout, stderr } = await execFileCapture(binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: execOptions.encoding ?? 'utf-8',
      maxBuffer: execOptions.maxBuffer,
      timeout: execOptions.timeout,
      env: execOptions.env,
      signal: execOptions.signal
    })
    return { stdout: stdout as string, stderr: stderr as string }
  } catch (error) {
    if (shouldRetryWindowsCommandShim(error, resolved)) {
      return spawnCommandCapture(
        resolveWindowsCommand(`${resolved.binary}.cmd`, options.env),
        resolved.args,
        {
          ...execOptions,
          cwd: resolved.cwd
        }
      )
    }
    throw error
  }
}

/**
 * Async git command execution that returns a Buffer.
 * Used for reading binary blobs (git show).
 */
export async function gitExecFileAsyncBuffer(
  args: string[],
  options: { cwd: string; maxBuffer?: number; wslDistro?: string }
): Promise<{ stdout: Buffer }> {
  if (isWslLinkedWorktreeGitRoutingCandidate(options.cwd, options.wslDistro)) {
    await prepareWslLinkedWorktreeGitRouting(options.cwd, options.wslDistro)
  }
  // `git show` is a read, so this normally runs with no shell at all. The fence
  // still matters for the login-shell fallback: these are raw blob bytes going
  // straight to the diff/blob viewer, where a banner becomes file content.
  let resolved = resolveGitCommand(args, options, false, true)
  const environmentReady = prepareWindowsHostGitEnvironment(resolved, undefined)
  if (environmentReady) {
    await environmentReady
  }
  resolved = resolveGitCommand(args, options, false, true)
  const { stdout } = (await execFileCapture(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: 'buffer',
    maxBuffer: options.maxBuffer,
    env: untranslatedGitOutputEnv()
  })) as { stdout: Buffer }
  return { stdout: readCapturedGitBuffer(stdout, resolved) }
}

/**
 * Slice a fenced payload out of raw bytes.
 *
 * Why bytes: blob content may be binary, so decoding to a string to find the
 * fence would corrupt it. Returns the buffer untouched when the command was not
 * fenced or the fence is absent.
 */
function readCapturedGitBuffer(stdout: Buffer, resolved: ResolvedCommand): Buffer {
  const captured = resolved.captured
  if (!captured) {
    return stdout
  }
  const beginIndex = stdout.indexOf(captured.beginMarker, 0, 'utf8')
  if (beginIndex === -1) {
    return stdout
  }
  const payloadStart = beginIndex + Buffer.byteLength(captured.beginMarker, 'utf8')
  const endIndex = stdout.indexOf(captured.endMarker, payloadStart, 'utf8')
  return endIndex === -1 ? stdout.subarray(payloadStart) : stdout.subarray(payloadStart, endIndex)
}

// ─── Generic command runner (for rg, etc.) ──────────────────────────

/**
 * Spawn any command with WSL awareness.
 * Used for non-git binaries like `rg` that also need WSL routing.
 */
export function wslAwareSpawn(
  command: string,
  args: string[],
  options: SpawnOptions & { cwd?: string; wslDistro?: string; useWslLoginShell?: boolean }
): ChildProcess {
  const { wslDistro, useWslLoginShell, ...spawnOptions } = options
  const resolved = resolveCommand(command, args, options.cwd, wslDistro, {
    useWslLoginShell
  })
  const binary = resolved.wsl ? 'wsl.exe' : resolved.binary
  const spawnStartedAt = performance.now()
  const child = spawn(binary, resolved.args, {
    ...spawnOptions,
    windowsHide: true,
    cwd: resolved.cwd
  })
  recordSubprocessSpawn(binary, resolved.args, performance.now() - spawnStartedAt)
  return child
}

// ─── Path translation helpers ───────────────────────────────────────

/**
 * Translate absolute Linux paths in git output back to Windows UNC paths.
 * Why: git-in-WSL emits Linux-native paths, but Orca reads files via Node fs, which needs Windows UNC.
 */
export function translateWslOutputPaths(
  output: string,
  originalCwd: string,
  options: { wslDistro?: string } = {}
): string {
  const wsl = parseWslPath(originalCwd)
  const distro = wsl?.distro ?? options.wslDistro
  if (!distro) {
    return output
  }

  // Rewrite absolute Linux paths in structured git output (e.g. "worktree /home/user/repo/feature") to Windows UNC.
  return output.replace(/(?<=worktree )(\/.+)$/gm, (_match, linuxPath: string) =>
    toWindowsWslPath(linuxPath, distro)
  )
}

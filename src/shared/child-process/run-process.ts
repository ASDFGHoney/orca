import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions as NodeSpawnOptions
} from 'node:child_process'
import { buildWindowsCmdShimCommandLine, isCmdInterpretedProgram } from './windows-command-line'

/**
 * The single place Orca starts a child process.
 *
 * Why one place: six decisions have to be made every time a child is spawned,
 * POSIX forgives all six, and Windows punishes each of them differently —
 * console visibility, argument quoting, `.cmd` interpretation, binary
 * resolution, timeout policy, and how the tree is later terminated. Made
 * per-call-site, they were right in some files and wrong in others, and the
 * wrong ones reached users as stolen keyboard focus, mangled agent prompts and
 * orphaned process trees.
 *
 * Callers outside this directory must not import `node:child_process`; a guard
 * test enforces that against a shrinking allowlist.
 */

export type ProcessSpec = {
  /**
   * Program to run. On Windows this should already be an absolute path —
   * spawning by bare name depends on the child's PATH, which under Group Policy
   * or a stripped Electron environment can resolve to nothing.
   */
  program: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Kill the process (and, on Windows, its console) after this long. */
  timeoutMs?: number
  /** Written to stdin then closed. Omit to leave stdin empty and closed. */
  input?: string
  /** Cap on captured stdout/stderr; beyond it the process is killed. */
  maxOutputBytes?: number
  signal?: AbortSignal
}

export type ProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** True when the process was killed by `timeoutMs` rather than exiting. */
  timedOut: boolean
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export type ResolvedSpawn = {
  file: string
  args: readonly string[]
  options: NodeSpawnOptions
}

/**
 * Translate a spec into the exact `child_process.spawn` call to make.
 *
 * Kept pure and exported so the Windows branch is testable from macOS/Linux:
 * the decisions below are the whole point of this module, and they must not be
 * observable only on the platform that breaks.
 */
export function resolveSpawn(spec: ProcessSpec, platform: NodeJS.Platform): ResolvedSpawn {
  const args = spec.args ?? []
  const base: NodeSpawnOptions = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Why unconditional: Orca's main process is GUI-subsystem and owns no
    // console, so every console-subsystem child it starts gets a fresh visible
    // conhost that takes foreground — keystrokes typed into an Orca terminal at
    // that moment land in the black box instead.
    windowsHide: true,
    // Why never `shell: true`: it concatenates arguments without escaping (Node
    // itself warns DEP0190) and it silently makes windowsHide a no-op.
    shell: false
  }

  if (platform !== 'win32' || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base }
  }

  // Node refuses to spawn `.cmd`/`.bat` without a shell (EINVAL, the
  // CVE-2024-27980 mitigation), so cmd.exe has to be the program. Building the
  // line ourselves — rather than handing Node `shell: true` — is what keeps the
  // arguments intact and the console hidden.
  const comSpec = spec.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe'
  return {
    file: comSpec,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...base, windowsVerbatimArguments: true }
  }
}

/** Start a child process. Use for long-lived or streaming children. */
export function spawnProcess(spec: ProcessSpec): ChildProcess {
  const resolved = resolveSpawn(spec, process.platform)
  return nodeSpawn(resolved.file, [...resolved.args], resolved.options)
}

/**
 * Run a child process to completion and capture its output.
 *
 * Never rejects on a non-zero exit — the exit code is data. Rejects only when
 * the process could not be started at all.
 */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnProcess(spec)
    } catch (error) {
      reject(error)
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false

    const collect = (chunks: Buffer[], chunk: Buffer, bytes: number): number => {
      const remaining = maxOutputBytes - bytes
      if (remaining <= 0) {
        return bytes
      }
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      return bytes + chunk.length
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderrChunks, chunk, stderrBytes)
    })

    const timer = setTimeout(() => {
      timedOut = true
      terminate(child)
    }, timeoutMs)
    timer.unref?.()

    const onAbort = (): void => terminate(child)
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    child.once('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('close', (code, signal) => finish(code, signal))

    if (spec.input !== undefined) {
      child.stdin?.end(spec.input)
    } else {
      // Why close rather than leave open: a child that reads stdin (a hook
      // draining its payload, a CLI probing for a TTY) otherwise blocks until
      // the timeout instead of seeing EOF immediately.
      child.stdin?.end()
    }
  })
}

/**
 * Best-effort termination of a captured child.
 *
 * Deliberately root-only: descendant reaping is the job-object owner's
 * responsibility, not every caller's.
 */
function terminate(child: ChildProcess): void {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
}

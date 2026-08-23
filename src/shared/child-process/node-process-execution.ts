import {
  execFile as nodeExecFile,
  execFileSync as nodeExecFileSync,
  spawn as nodeSpawn,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptions,
  type SpawnOptions
} from 'node:child_process'

export type SpawnedProcess = ChildProcess
export type SpawnedProcessOptions = SpawnOptions
export type ExecutedFileOptions = ExecFileOptions
export type ExecutedFileCallback = (
  error: ExecFileException | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void

/** Spawn with Node semantics while retaining the main-process no-console invariant. */
export function spawnNodeProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess {
  return nodeSpawn(command, [...args], { ...options, windowsHide: true })
}

/** Execute a file with Node callback semantics and a hidden Windows console. */
export function execNodeFile(
  command: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecutedFileCallback
): ChildProcess {
  return nodeExecFile(
    command,
    [...args],
    { ...options, windowsHide: true },
    callback as Parameters<typeof nodeExecFile>[3]
  )
}

/** Synchronous counterpart used only by genuinely synchronous Git probes. */
export function execNodeFileSync(
  command: string,
  args: readonly string[],
  options: Parameters<typeof nodeExecFileSync>[2]
): string | Buffer {
  return nodeExecFileSync(command, [...args], { ...options, windowsHide: true })
}

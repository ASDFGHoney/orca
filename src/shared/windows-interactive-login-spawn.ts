import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { getSpawnArgsForWindows, wrapWindowsStartWait } from './windows-batch-spawn'

export type WindowsHostInteractiveLoginSpawn = {
  command: string
  args: string[]
  stdio: 'ignore'
  windowsHide: boolean
  cleanup: () => void
  getTerminationPid: () => number | null
}

function encodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function buildPidRelayScript(command: string, args: string[], pidFilePath: string): string {
  const decode =
    'function Read-OrcaValue([string]$Value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value)) }'
  const encodedArgs = args.map((arg) => `(Read-OrcaValue '${encodeUtf8(arg)}')`).join(',')
  return [
    decode,
    `$Command = Read-OrcaValue '${encodeUtf8(command)}'`,
    `$Arguments = @(${encodedArgs})`,
    `[IO.File]::WriteAllText((Read-OrcaValue '${encodeUtf8(pidFilePath)}'), [string]$PID)`,
    '& $Command @Arguments',
    'if ($null -eq $LASTEXITCODE) { exit 0 }',
    'exit $LASTEXITCODE'
  ].join('; ')
}

function readPidFile(pidFilePath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidFilePath, 'utf8').trim(), 10)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function buildWindowsHostInteractiveLoginSpawn(
  command: string,
  args: string[]
): WindowsHostInteractiveLoginSpawn {
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)
  const pidFilePath = join(tmpdir(), `orca-interactive-login-${randomUUID()}.pid`)
  const powershell = win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = buildPidRelayScript(spawnCmd, spawnArgs, pidFilePath)
  const wrapped = wrapWindowsStartWait(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ])
  return {
    command: wrapped.spawnCmd,
    args: wrapped.spawnArgs,
    stdio: 'ignore',
    windowsHide: true,
    cleanup: () => rmSync(pidFilePath, { force: true }),
    getTerminationPid: () => readPidFile(pidFilePath)
  }
}

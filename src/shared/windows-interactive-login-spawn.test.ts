import { describe, expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { getCmdExePath } from './windows-batch-spawn'
import { buildWindowsHostInteractiveLoginSpawn } from './windows-interactive-login-spawn'

function withWindows<T>(fn: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

function encodedValue(value: string): string {
  return `Read-OrcaValue '${Buffer.from(value).toString('base64')}'`
}

describe('buildWindowsHostInteractiveLoginSpawn', () => {
  it('relays a batch login through a visible, PID-addressable console', () => {
    const spawn = withWindows(() =>
      buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\claude.cmd', [
        'auth',
        'login',
        '--claudeai'
      ])
    )
    expect(spawn.command).toBe(getCmdExePath())
    expect(spawn.args.slice(0, 5)).toEqual(['/d', '/c', 'start', '', '/wait'])
    expect(spawn.args[5]).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
    expect(spawn.args.slice(6, 11)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ])

    const script = Buffer.from(spawn.args[11] ?? '', 'base64').toString('utf16le')
    expect(script).toContain('[string]$PID')
    expect(script).toContain(encodedValue(getCmdExePath()))
    expect(script).toContain(encodedValue('C:\\Tools\\claude.cmd'))
    expect(script).toContain(encodedValue('--claudeai'))
    const pidPathBase64 = script.match(
      /WriteAllText\(\(Read-OrcaValue '([^']+)'\), \[string\]\$PID\)/
    )?.[1]
    expect(pidPathBase64).toBeTruthy()
    const pidFilePath = Buffer.from(pidPathBase64!, 'base64').toString('utf8')

    expect(spawn.stdio).toBe('ignore')
    expect(spawn.windowsHide).toBe(true)
    expect(spawn.getTerminationPid()).toBeNull()
    writeFileSync(pidFilePath, '2468')
    expect(spawn.getTerminationPid()).toBe(2468)
    spawn.cleanup()
    expect(existsSync(pidFilePath)).toBe(false)
  })

  it('routes executable logins through the same waiting console boundary', () => {
    const spawn = withWindows(() =>
      buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\codex.exe', ['login'])
    )
    const script = Buffer.from(spawn.args[11] ?? '', 'base64').toString('utf16le')
    expect(script).toContain(encodedValue('C:\\Tools\\codex.exe'))
    expect(script).toContain(encodedValue('login'))
    spawn.cleanup()
  })
})

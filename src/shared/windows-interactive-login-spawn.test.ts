import { describe, expect, it } from 'vitest'
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

describe('buildWindowsHostInteractiveLoginSpawn', () => {
  it('launches a batch login in a visible console and waits for it', () => {
    const spawn = withWindows(() =>
      buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\claude.cmd', [
        'auth',
        'login',
        '--claudeai'
      ])
    )
    expect(spawn.command).toBe(getCmdExePath())
    expect(spawn.args).toEqual([
      '/d',
      '/c',
      'start',
      '',
      '/wait',
      getCmdExePath(),
      '/d',
      '/c',
      'C:\\Tools\\claude.cmd',
      'auth',
      'login',
      '--claudeai'
    ])
    expect(spawn.stdio).toBe('ignore')
    expect(spawn.windowsHide).toBe(true)
  })

  it('routes executable logins through the same waiting console boundary', () => {
    const spawn = buildWindowsHostInteractiveLoginSpawn('C:\\Tools\\codex.exe', ['login'])
    expect(spawn).toEqual({
      command: getCmdExePath(),
      args: ['/d', '/c', 'start', '', '/wait', 'C:\\Tools\\codex.exe', 'login'],
      stdio: 'ignore',
      windowsHide: true
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { getCmdExePath } from './windows-batch-spawn'
import { buildWindowsHostInteractiveLoginSpawn } from './windows-interactive-login-spawn'

describe('buildWindowsHostInteractiveLoginSpawn', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  it('passes console device fds when CONIN$ opens', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const dispose = vi.fn()
      const spawn = buildWindowsHostInteractiveLoginSpawn('claude.exe', ['auth', 'login'], () => ({
        stdio: [11, 12, 12],
        dispose
      }))
      expect(spawn).toEqual({
        command: 'claude.exe',
        args: ['auth', 'login'],
        stdio: [11, 12, 12],
        windowsHide: false,
        dispose
      })
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('falls back to a hidden start /wait wrapper when no console exists', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const spawn = buildWindowsHostInteractiveLoginSpawn(
        'C:\\Tools\\claude.cmd',
        ['auth', 'login', '--claudeai'],
        () => 'inherit'
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
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })
})

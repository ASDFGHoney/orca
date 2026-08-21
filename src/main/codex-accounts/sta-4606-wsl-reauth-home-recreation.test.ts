import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { buildWslCodexLoginArgs } from './wsl-codex-command'
import {
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

function decodeEncodedWslBashCommand(command: string): string {
  const encoded = command.match(/^set -o pipefail; printf %s '([^']+)' \| base64 -d \| bash$/)?.[1]
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : command
}

function scriptWritesManagedHome(script: string): boolean {
  return script.includes('mkdir -p') && script.includes('.orca-managed-home')
}

describe('STA-4606 WSL re-auth must not rewrite a home it could not prove absent', () => {
  registerCodexAccountsTestHomes()

  it('does not send mkdir/marker rewrite when the guest probe cannot classify the home', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    mkdirSync(wslManagedHomePath, { recursive: true })
    writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(wslManagedHomePath, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: `header.${Buffer.from(JSON.stringify({ email: 'old@example.com' })).toString(
            'base64url'
          )}.signature`
        }
      }),
      'utf-8'
    )

    const writeScripts: string[] = []
    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      if (scriptWritesManagedHome(script)) {
        writeScripts.push(script)
      }
      const error = Object.assign(new Error('Permission denied'), { status: 13 })
      throw error
    })
    const spawnMock = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn()
      queueMicrotask(() => child.emit('close', 0))
      return child
    })

    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Ubuntu', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: 'account-1' }
      }
    })
    const store = createStore(settings)

    try {
      const { CodexAccountService } = await import('./service')
      const { ManagedCodexHomeTemporarilyUnavailableError } =
        await import('./host-codex-managed-home-ownership')
      const service = new CodexAccountService(
        store as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )

      await expect(service.reauthenticateAccount('account-1')).rejects.toBeInstanceOf(
        ManagedCodexHomeTemporarilyUnavailableError
      )
      expect(writeScripts).toEqual([])
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('still recreates the home after a definitive guest-side absence', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-missing-home', 'home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    mkdirSync(wslManagedHomePath, { recursive: true })
    writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(wslManagedHomePath, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: `header.${Buffer.from(JSON.stringify({ email: 'old@example.com' })).toString(
            'base64url'
          )}.signature`
        }
      }),
      'utf-8'
    )

    const writeScripts: string[] = []
    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      if (scriptWritesManagedHome(script)) {
        writeScripts.push(script)
        return ''
      }
      if (script.includes('readlink -f')) {
        return `${wslLinuxHomePath}\n`
      }
      if (script.includes('stat') || script.includes('[ ! -e') || script.includes('[ -e ')) {
        throw Object.assign(new Error('No such file or directory'), { status: 2 })
      }
      return ''
    })
    const spawnMock = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('wsl.exe')
      expect(args).toEqual(buildWslCodexLoginArgs('Ubuntu', wslLinuxHomePath))
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn()
      writeFileSync(
        join(wslManagedHomePath, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: `header.${Buffer.from(JSON.stringify({ email: 'new@example.com' })).toString(
              'base64url'
            )}.signature`
          }
        }),
        'utf-8'
      )
      queueMicrotask(() => child.emit('close', 0))
      return child
    })

    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Ubuntu', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: 'account-1' }
      }
    })
    const store = createStore(settings)

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )

      const result = await service.reauthenticateAccount('account-1')
      expect(writeScripts.length).toBeGreaterThan(0)
      expect(result.accounts[0]?.email).toBe('new@example.com')
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})

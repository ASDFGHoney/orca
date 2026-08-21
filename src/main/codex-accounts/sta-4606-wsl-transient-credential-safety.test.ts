import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

// STA-4606: WSL sync treated an unreadable path as absence, then deselecting,
// overwriting, or deleting credentials. A held EPERM must not authorize those.

const denials = vi.hoisted(() => {
  const state = {
    paths: new Set<string>(),
    reads: new Map<string, number>(),
    removals: [] as string[],
    deny(path: string): void {
      state.paths.add(path)
    },
    release(path: string): void {
      state.paths.delete(path)
    },
    readsFor(path: string): number {
      return state.reads.get(path) ?? 0
    },
    reset(): void {
      state.paths.clear()
      state.reads.clear()
      state.removals = []
    },
    check(target: unknown, syscall: string): void {
      if (typeof target !== 'string' || !state.paths.has(target)) {
        return
      }
      state.reads.set(target, (state.reads.get(target) ?? 0) + 1)
      const error: NodeJS.ErrnoException = new Error(
        `EPERM: operation not permitted, ${syscall} '${target}'`
      )
      error.code = 'EPERM'
      error.errno = -4048
      error.syscall = syscall
      error.path = target
      throw error
    }
  }
  return state
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const guard = (fn: unknown, syscall: string): unknown => {
    const original = fn as (...args: unknown[]) => unknown
    const wrapped = (...args: unknown[]): unknown => {
      denials.check(args[0], syscall)
      return original(...args)
    }
    return Object.assign(wrapped, original)
  }
  const patched: Record<string, unknown> = {
    ...actual,
    readFileSync: guard(actual.readFileSync, 'read'),
    lstatSync: guard(actual.lstatSync, 'lstat'),
    statSync: guard(actual.statSync, 'stat'),
    accessSync: guard(actual.accessSync, 'access'),
    openSync: guard(actual.openSync, 'open'),
    rmSync: Object.assign((...args: unknown[]) => {
      if (typeof args[0] === 'string') {
        denials.removals.push(args[0])
      }
      denials.check(args[0], 'rm')
      return actual.rmSync(...(args as Parameters<typeof actual.rmSync>))
    }, actual.rmSync),
    existsSync: Object.assign((...args: unknown[]): boolean => {
      if (typeof args[0] === 'string' && denials.paths.has(args[0])) {
        denials.reads.set(args[0], (denials.reads.get(args[0]) ?? 0) + 1)
        return false
      }
      return actual.existsSync(args[0] as string)
    }, actual.existsSync)
  }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const realFs = await vi.importActual<typeof NodeFs>('node:fs')

const WSL_TARGET = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

function wslRuntimeHomePath(wslHome: string): string {
  return join(wslHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home')
}

function createWslAccount(managedHomePath: string, id = 'account-1') {
  return {
    id,
    email: 'wsl@example.com',
    managedHomePath,
    managedHomeRuntime: 'wsl' as const,
    wslDistro: 'Ubuntu',
    wslLinuxHomePath: `/home/alice/.local/share/orca/codex-accounts/${id}/home`,
    providerAccountId: 'acct-wsl',
    workspaceLabel: null,
    workspaceAccountId: 'acct-wsl',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

async function createWslService(options: {
  wslHome: string
  getWslHome?: () => string | null
  managedAuth?: string
  omitManagedAuth?: boolean
  systemAuth?: string
  runtimeAuth?: string
  managedConfig?: string
  systemConfig?: string
}) {
  vi.doMock('../wsl', () => ({
    getDefaultWslDistro: () => 'Ubuntu',
    getWslHome: options.getWslHome ?? (() => options.wslHome)
  }))
  const managedHomePath = createManagedAuth(
    testState.userDataDir,
    'account-1',
    options.managedAuth ?? createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed', 1_000)
  )
  if (options.omitManagedAuth) {
    realFs.rmSync(join(managedHomePath, 'auth.json'), { force: true })
  }
  if (options.managedConfig !== undefined) {
    realFs.writeFileSync(join(managedHomePath, 'config.toml'), options.managedConfig, 'utf-8')
  }
  const systemCodexHomePath = join(options.wslHome, '.codex')
  realFs.mkdirSync(systemCodexHomePath, { recursive: true })
  if (options.systemAuth !== undefined) {
    realFs.writeFileSync(join(systemCodexHomePath, 'auth.json'), options.systemAuth, 'utf-8')
  }
  if (options.systemConfig !== undefined) {
    realFs.writeFileSync(join(systemCodexHomePath, 'config.toml'), options.systemConfig, 'utf-8')
  }
  const runtimeHome = wslRuntimeHomePath(options.wslHome)
  if (options.runtimeAuth !== undefined) {
    realFs.mkdirSync(runtimeHome, { recursive: true })
    realFs.writeFileSync(join(runtimeHome, 'auth.json'), options.runtimeAuth, 'utf-8')
  }
  const store = createStore(
    createSettings({
      codexManagedAccounts: [createWslAccount(managedHomePath)],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
    })
  )
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  return {
    service: new CodexRuntimeHomeService(store as never),
    store,
    managedHomePath,
    runtimeHome,
    runtimeAuthPath: join(runtimeHome, 'auth.json'),
    managedAuthPath: join(managedHomePath, 'auth.json'),
    systemAuthPath: join(systemCodexHomePath, 'auth.json'),
    runtimeConfigPath: join(runtimeHome, 'config.toml'),
    managedConfigPath: join(managedHomePath, 'config.toml'),
    systemConfigPath: join(systemCodexHomePath, 'config.toml')
  }
}

describe('STA-4606 WSL unreadable paths must not destroy credentials', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    denials.reset()
    setupRuntimeHomeTest()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    denials.reset()
    teardownRuntimeHomeTest()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('does not rmSync the runtime auth mirror when the system auth probe is unreadable', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    const runtimeAuth = createCodexAuthJson('runtime@example.com', 'acct-runtime', 'live', 3_000)
    const ctx = await createWslService({
      wslHome,
      omitManagedAuth: true,
      runtimeAuth
    })
    denials.deny(ctx.systemAuthPath)

    ctx.service.syncForCurrentSelection(WSL_TARGET)

    expect(denials.readsFor(ctx.systemAuthPath)).toBeGreaterThan(0)
    expect(denials.removals).not.toContain(ctx.runtimeAuthPath)
    expect(realFs.readFileSync(ctx.runtimeAuthPath, 'utf-8')).toBe(runtimeAuth)
  })

  it('does not overwrite a fresher rotated runtime token after a read-back failure', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    const managedAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed-stale', 1_000)
    const rotated = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'runtime-rotated', 2_000)
    const ctx = await createWslService({ wslHome, managedAuth })

    expect(ctx.service.prepareForCodexLaunch(WSL_TARGET)).toBe(ctx.runtimeHome)
    realFs.writeFileSync(ctx.runtimeAuthPath, rotated, 'utf-8')
    denials.deny(ctx.runtimeAuthPath)

    ctx.service.syncForCurrentSelection(WSL_TARGET)

    expect(denials.readsFor(ctx.runtimeAuthPath)).toBeGreaterThan(0)
    expect(realFs.readFileSync(ctx.runtimeAuthPath, 'utf-8')).toBe(rotated)
    expect(realFs.readFileSync(ctx.managedAuthPath, 'utf-8')).toBe(managedAuth)
    expect(ctx.store.updateSettings).not.toHaveBeenCalled()
  })

  it('does not null the distro selection when the managed auth.json is unreadable', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    const ctx = await createWslService({ wslHome })
    denials.deny(ctx.managedAuthPath)

    expect(ctx.service.prepareForRateLimitFetch(WSL_TARGET)).toEqual({ kind: 'skip' })
    expect(() => ctx.service.prepareForCodexLaunch(WSL_TARGET)).toThrow(/temporarily locked/)
    expect(denials.readsFor(ctx.managedAuthPath)).toBeGreaterThan(0)
    expect(ctx.store.updateSettings).not.toHaveBeenCalled()
    expect(ctx.store.getSettings().activeCodexManagedAccountIdsByRuntime).toEqual({
      host: null,
      wsl: { Ubuntu: 'account-1' }
    })
  })

  it('does not seed a system config into a managed runtime home on an unreadable managed config', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    const ctx = await createWslService({
      wslHome,
      managedConfig: 'model = "managed-only"\n',
      systemConfig: 'model = "system-fallback"\n'
    })
    denials.deny(ctx.managedConfigPath)

    ctx.service.syncForCurrentSelection(WSL_TARGET)

    expect(denials.readsFor(ctx.managedConfigPath)).toBeGreaterThan(0)
    expect(realFs.existsSync(ctx.runtimeConfigPath)).toBe(false)
  })

  it('still deselects and restores system auth when managed auth.json is proven absent', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    const ctx = await createWslService({
      wslHome,
      omitManagedAuth: true,
      systemAuth
    })

    expect(ctx.service.prepareForCodexLaunch(WSL_TARGET)).toBe(ctx.runtimeHome)
    expect(ctx.store.updateSettings).toHaveBeenCalledWith({
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
    })
    expect(realFs.readFileSync(ctx.runtimeAuthPath, 'utf-8')).toBe(systemAuth)
  })

  it('still removes the runtime auth mirror when both managed and system auth are proven absent', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    const leftover = createCodexAuthJson('stale@example.com', 'acct-stale', 'leftover')
    const ctx = await createWslService({
      wslHome,
      omitManagedAuth: true,
      runtimeAuth: leftover
    })

    ctx.service.syncForCurrentSelection(WSL_TARGET)

    expect(denials.removals).toContain(ctx.runtimeAuthPath)
    expect(realFs.existsSync(ctx.runtimeAuthPath)).toBe(false)
  })

  it('skips the poll and refuses launch when the WSL home probe cannot answer', async () => {
    const wslHome = join(testState.userDataDir, 'wsl-home')
    const ctx = await createWslService({
      wslHome,
      getWslHome: () => null
    })

    expect(ctx.service.prepareForRateLimitFetch(WSL_TARGET)).toEqual({ kind: 'skip' })
    expect(() => ctx.service.prepareForCodexLaunch(WSL_TARGET)).toThrow(/could not be reached/)
    expect(ctx.store.updateSettings).not.toHaveBeenCalled()
    expect(realFs.existsSync(ctx.runtimeAuthPath)).toBe(false)
  })
})

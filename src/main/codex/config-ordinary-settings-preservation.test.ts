import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-ordinary-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-ordinary-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  if (homedir() !== tmpHome) {
    throw new Error('node:os homedir mock is not active; refusing to touch the real ~/.codex')
  }
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

function systemConfigPath(): string {
  return join(tmpHome, '.codex', 'config.toml')
}

function runtimeHomeDir(): string {
  return join(userDataDir, 'codex-runtime-home', 'home')
}

function runtimeConfigPath(): string {
  return join(runtimeHomeDir(), 'config.toml')
}

function writeSystemConfig(content: string): void {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true })
  writeFileSync(systemConfigPath(), content, 'utf-8')
}

function readSystemConfig(): string {
  return readFileSync(systemConfigPath(), 'utf-8')
}

function readRuntimeConfig(): string {
  return readFileSync(runtimeConfigPath(), 'utf-8')
}

function setRuntimeConfig(content: string): void {
  mkdirSync(runtimeHomeDir(), { recursive: true })
  writeFileSync(runtimeConfigPath(), content, 'utf-8')
}

describe('ordinary Codex settings survive a managed-home remirror', () => {
  it('preserves top-level model and model_reasoning_effort written in the runtime home', () => {
    writeSystemConfig('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "max"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('model = "gpt-5.6-sol"')
    expect(readRuntimeConfig()).toContain('model_reasoning_effort = "max"')
    expect(readSystemConfig()).toContain('model = "gpt-5.6-sol"')
    expect(readSystemConfig()).toContain('model_reasoning_effort = "max"')
  })

  it('still promotes a runtime [tui] block into ~/.codex and keeps it after remirror', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark-photon"\nstatus_line = ["model"]\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readSystemConfig()).toContain('[tui]')
    expect(readSystemConfig()).toContain('theme = "dark-photon"')
    expect(readSystemConfig()).toContain('status_line = ["model"]')
    expect(readRuntimeConfig()).toContain('theme = "dark-photon"')
    expect(readRuntimeConfig()).toContain('status_line = ["model"]')
  })

  it('keeps Orca-rewritten path keys on the prepared system values, not stale runtime paths', () => {
    writeSystemConfig('model = "gpt-5"\nlog_dir = "logs"\n')
    syncSystemConfigIntoManagedCodexHome()

    const rewrittenLogDir = `log_dir = '${join(tmpHome, '.codex', 'logs')}'`
    expect(readRuntimeConfig()).toContain(rewrittenLogDir)

    setRuntimeConfig(`model = "gpt-5"\nlog_dir = "/stale/user/logs"\n`)
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain(rewrittenLogDir)
    expect(readRuntimeConfig()).not.toContain('/stale/user/logs')
    expect(readSystemConfig()).toContain('log_dir = "logs"')
    expect(readSystemConfig()).not.toContain('/stale/user/logs')
  })

  it('carries an unrelated user-set key through a remirror without writing it into ~/.codex', () => {
    writeSystemConfig('model = "gpt-5"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\npersonality = "nerdy"\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('personality = "nerdy"')
    expect(readSystemConfig()).toBe('model = "gpt-5"\n')
    expect(existsSync(systemConfigPath())).toBe(true)
  })

  it('carries an unlisted [tui] neighbor through a remirror', () => {
    writeSystemConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark"\n')
    syncSystemConfigIntoManagedCodexHome()

    setRuntimeConfig('model = "gpt-5"\n\n[tui]\ntheme = "dark"\nanimations = false\n')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('animations = false')
    expect(readSystemConfig()).not.toContain('animations')
  })
})

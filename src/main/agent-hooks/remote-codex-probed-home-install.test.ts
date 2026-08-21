import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'

const tempHomes: string[] = []

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe.runIf(process.platform !== 'win32')('SSH Codex probed-home hook install', () => {
  it('writes Codex trust immediately when installing into a probed CODEX_HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-codex-probed-home-'))
    tempHomes.push(home)
    const runtimeHome = join(home, '.config', 'codex')

    const results = await installRemoteManagedAgentHooks(createManagedHookLocalFilesystem(), home, {
      agents: ['codex'],
      codexHomeDir: runtimeHome
    })

    expect(results).toEqual([
      expect.objectContaining({ agent: 'codex', state: 'installed', managedHooksPresent: true })
    ])
    const hooks = await readFile(join(runtimeHome, 'hooks.json'), 'utf8')
    expect(hooks).toContain('codex-hook.sh')
    const toml = await readFile(join(runtimeHome, 'config.toml'), 'utf8')
    expect(toml).toContain('trusted_hash = "sha256:')
    await expect(readdir(join(home, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARINE_CREATURES } from '../shared/marine-creatures'
import { createRetiredNameLookup } from '../shared/worktree/retired-name-registry'

const { runWslTranscriptFsTaskMock, getWslHomeAsyncMock } = vi.hoisted(() => ({
  runWslTranscriptFsTaskMock: vi.fn(),
  getWslHomeAsyncMock: vi.fn()
}))

vi.mock('./native-chat/wsl-transcript-fs-gate', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  runWslTranscriptFsTask: runWslTranscriptFsTaskMock
}))

// Why the whole module is not replaced: `worktree-name-retirement` reads `parseWslPath` and
// `hasCachedWslHome` from here on the same code path under test.
vi.mock('./wsl', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getWslHomeAsync: getWslHomeAsyncMock
}))

const { discoverRetiredWorktreeNames } = await import('./worktree-retirement-discovery')
const { ensureRetiredWorktreeNamesBackfilled } = await import('./worktree-name-retirement')
const { WslTranscriptFsError } = await import('./native-chat/wsl-transcript-fs-gate')

const FIRST = MARINE_CREATURES[0].toLowerCase()
const DISTRO_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\orca\\workspaces'

describe('retirement discovery on WSL', () => {
  beforeEach(() => {
    runWslTranscriptFsTaskMock.mockReset()
    getWslHomeAsyncMock.mockReset()
    // Pass through by default: the gate's own admission logic has its own tests.
    runWslTranscriptFsTaskMock.mockImplementation(
      (_options: unknown, task: (signal: AbortSignal) => Promise<unknown>) =>
        task(new AbortController().signal)
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('admits every WSL UNC listing through the bounded filesystem gate', async () => {
    await discoverRetiredWorktreeNames({
      workspaceRoots: [DISTRO_ROOT],
      home: '/nonexistent-home',
      env: {},
      resolveWslHome: async () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
    })

    // Both UNC reads — the workspace root and the distro's bucket directory — are admitted, at the
    // scan priority that leaves the exact-probe permit free.
    expect(runWslTranscriptFsTaskMock.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ operation: 'readdir', path: DISTRO_ROOT, priority: 'scan' }),
      expect.objectContaining({
        operation: 'readdir',
        path: join('\\\\wsl.localhost\\Ubuntu\\home\\ada', '.claude', 'projects'),
        priority: 'scan'
      })
    ])
  })

  it('leaves no listing ungated when the workspace root is on the Windows side', async () => {
    await discoverRetiredWorktreeNames({
      workspaceRoots: ['C:\\Users\\ada\\orca\\workspaces'],
      home: '/nonexistent-home',
      env: {}
    })

    expect(runWslTranscriptFsTaskMock).not.toHaveBeenCalled()
  })

  it('reports a gate refusal as incomplete but still returns what the host side could read', async () => {
    // Marking it incomplete is what stops "nothing is retired" being cached for the process
    // lifetime — the one direction that reissues a cwd whose history is still on the distro.
    // Throwing instead would be worse than the pre-split behaviour: for a WSL repo the UNC
    // workspace root is listed first, so a stuck 9P route would also discard the plain, readable
    // Windows-side bucket scan that needs no distro access at all.
    runWslTranscriptFsTaskMock.mockRejectedValue(
      new WslTranscriptFsError('timeout', 'filesystem access is taking too long')
    )
    const hostHome = await mkdtemp(join(tmpdir(), 'orca-wsl-host-home-'))
    try {
      await mkdir(
        join(
          hostHome,
          '.claude',
          'projects',
          `--wsl-localhost-ubuntu-home-ada-orca-workspaces-${FIRST}`
        ),
        { recursive: true }
      )

      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: [DISTRO_ROOT],
        home: hostHome,
        env: {},
        resolveWslHome: async () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })

      expect(retired.complete).toBe(false)
      expect(retired.names).toEqual(new Set([FIRST]))
    } finally {
      await rm(hostHome, { force: true, recursive: true })
    }
  })

  it('stays retryable when the distro home cannot be resolved, rather than memoizing the hole', async () => {
    // `getWslHomeAsync` shells out to `wsl.exe` and returns null for a stopped or slow distro.
    // Memoizing that as a complete "nothing is retired" is the STA-4472 defect itself, since the
    // distro is precisely where a WSL workspace's history lives.
    const retired = await discoverRetiredWorktreeNames({
      workspaceRoots: [DISTRO_ROOT],
      home: '/nonexistent-home',
      env: {},
      resolveWslHome: async () => null
    })

    expect(retired.complete).toBe(false)
  })

  it('keeps a deleted WSL workspace name spent, so the next create cannot reuse its cwd', async () => {
    // Delete/recreate: the workspace directory is gone, but the agent ran inside the distro and its
    // bucket survives there. That bucket is the only remaining evidence the cwd is unsafe.
    const distroHome = await mkdtemp(join(tmpdir(), 'orca-wsl-distro-home-'))
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'orca-wsl-workspaces-'))
    try {
      await mkdir(join(distroHome, '.claude', 'projects', `-home-ada-orca-workspaces-${FIRST}`), {
        recursive: true
      })

      const retired = await discoverRetiredWorktreeNames({
        // The root is listed under its real (empty) path; the UNC spelling supplies the distro.
        workspaceRoots: [DISTRO_ROOT],
        home: workspaceRoot,
        env: {},
        resolveWslHome: async () => distroHome
      })

      expect(retired.names).toEqual(new Set([FIRST]))
      expect(createRetiredNameLookup({ exhaustedTiers: 0, names: [...retired.names] })(FIRST)).toBe(
        true
      )
    } finally {
      await rm(distroHome, { force: true, recursive: true })
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  })

  it('reaches distro discovery from the real backfill, not only when called directly', async () => {
    // Wiring, not discovery: every test above calls the module directly, so all of them stay green
    // if `ensureRetiredWorktreeNamesBackfilled` keeps scanning the Windows home alone. That is the
    // shape STA-4472 shipped in, so the only caller production has is asserted here.
    const distroHome = await mkdtemp(join(tmpdir(), 'orca-wsl-backfill-home-'))
    try {
      await mkdir(join(distroHome, '.claude', 'projects', `-home-ada-orca-workspaces-${FIRST}`), {
        recursive: true
      })
      // Serves both the workspace-root mirror and the distro bucket lookup.
      getWslHomeAsyncMock.mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\ada')
      runWslTranscriptFsTaskMock.mockImplementation(
        (options: { path: string }, task: (signal: AbortSignal) => Promise<unknown>) => {
          // Stands in for the distro's bucket directory, which only exists behind the UNC root.
          const claudeRoot = join('\\\\wsl.localhost\\Ubuntu\\home\\ada', '.claude', 'projects')
          return options.path === claudeRoot
            ? readdir(join(distroHome, '.claude', 'projects'), { withFileTypes: true })
            : task(new AbortController().signal)
        }
      )
      const merged: string[] = []

      await ensureRetiredWorktreeNamesBackfilled(
        {
          mergeRetiredWorktreeNames: (_repoId: string, names: Iterable<string>) => {
            merged.push(...names)
            return true
          }
        } as never,
        {
          id: 'repo-wsl',
          path: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repos\\a',
          displayName: 'a',
          badgeColor: '',
          addedAt: 0
        } as never,
        // The workspace dir is the UNC root itself. `wsl.ts`'s `parseWslPath` short-circuits off
        // win32, so routing through the repo path instead would make this assert nothing on CI's
        // Linux and macOS runners — the distro half of discovery keys on the root string.
        { workspaceDir: DISTRO_ROOT, nestWorkspaces: false }
      )

      expect(merged).toContain(FIRST)
    } finally {
      await rm(distroHome, { force: true, recursive: true })
    }
  })
})

import { execFileSync } from 'node:child_process'
import type { Page } from '@stablyai/playwright-test'
import { buildWslExecArgs } from '../../../src/shared/wsl-login-shell-command'

/** Distro path the stub is staged at. Only reachable from inside WSL, so the
 *  stub's marker in a pane is itself proof the pane executed in the distro. */
const WSL_STUB_PATH = '/usr/local/bin/golden-stub-agent'
const WSL_STUB_AGENT_LINK = '/usr/local/bin/codex'

// Why printf and not a heredoc: the whole script crosses to wsl.exe as one argv
// element, and keeping it newline-free avoids Windows argv-encoding surprises.
const STAGE_SCRIPT =
  `mkdir -p /usr/local/bin && ` +
  `printf '#!/bin/sh\\necho GOLDEN_STUB_AGENT_READY\\nexec sleep 3600\\n' > ${WSL_STUB_PATH} && ` +
  `chmod 0755 ${WSL_STUB_PATH} && ` +
  `ln -sf ${WSL_STUB_PATH} ${WSL_STUB_AGENT_LINK}`

const UNSTAGE_SCRIPT = `rm -f ${WSL_STUB_AGENT_LINK} ${WSL_STUB_PATH}`

// Why --exec (via buildWslExecArgs): under `--`, wsl.exe expands `$name` in
// every argument and silently rewrites the script.
function runInWslAsRoot(distro: string, script: string): void {
  execFileSync('wsl.exe', ['-u', 'root', ...buildWslExecArgs(distro, ['sh', '-c', script])], {
    stdio: 'pipe',
    windowsHide: true
  })
}

export async function getFirstWslDistro(page: Page): Promise<string | null> {
  const wsl = await page.evaluate(async () => ({
    available: await window.api.wsl.isAvailable(),
    distros: await window.api.wsl.listDistros()
  }))
  return wsl.available ? (wsl.distros[0] ?? null) : null
}

/** Returns false when the distro won't take the stub (no root interop, read-only
 *  rootfs); callers skip rather than fail, since that is a host limitation. */
export function stageWslGoldenStubAgent(distro: string): boolean {
  try {
    runInWslAsRoot(distro, STAGE_SCRIPT)
    return true
  } catch {
    return false
  }
}

export function removeWslGoldenStubAgent(distro: string): void {
  try {
    runInWslAsRoot(distro, UNSTAGE_SCRIPT)
  } catch {
    // Best-effort cleanup; a leftover stub only affects this fixture's own name.
  }
}

/** Points the active worktree's project at the WSL runtime, so agent detection
 *  and terminal spawn both target the distro instead of the Windows host. */
export async function useWslRuntimeForActiveProject(page: Page, distro: string): Promise<void> {
  await page.evaluate(async (wslDistro) => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }
    const activeWorktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === worktreeId)
    const activeProject = state.projects.find((project) =>
      activeWorktree ? project.sourceRepoIds.includes(activeWorktree.repoId) : false
    )
    if (!activeProject) {
      throw new Error('No active project')
    }
    await state.updateProject(activeProject.id, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: wslDistro }
    })
  }, distro)
}

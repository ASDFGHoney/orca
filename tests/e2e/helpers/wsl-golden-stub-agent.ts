import { execFileSync } from 'node:child_process'
import type { Page } from '@stablyai/playwright-test'
import { buildWslExecArgs } from '../../../src/shared/wsl-login-shell-command'

/** A WSL-only path makes the stub marker proof that the pane ran in the distro. */
const WSL_STUB_PATH = '/usr/local/bin/golden-stub-agent'
const WSL_STUB_AGENT_LINK = '/usr/local/bin/codex'
const WSL_STUB_BACKUP_PATH = '/usr/local/bin/golden-stub-agent.orca-e2e-backup'

// Keep the cross-boundary script newline-free to avoid Windows argv-encoding surprises.
// Moving the entry avoids following and overwriting a pre-existing symlink.
const BACKUP_EXISTING_STUB_SCRIPT =
  `mkdir -p /usr/local/bin && ` +
  `if [ -e ${WSL_STUB_BACKUP_PATH} ] || [ -L ${WSL_STUB_BACKUP_PATH} ]; then exit 1; fi && ` +
  `if [ -e ${WSL_STUB_PATH} ] || [ -L ${WSL_STUB_PATH} ]; then ` +
  `mv ${WSL_STUB_PATH} ${WSL_STUB_BACKUP_PATH} && ` +
  `printf backed-up; else printf none; fi`

const STAGE_SCRIPT =
  `mkdir -p /usr/local/bin && ` +
  `printf '#!/bin/sh\\necho GOLDEN_STUB_AGENT_READY\\nexec sleep 3600\\n' > ${WSL_STUB_PATH} && ` +
  `chmod 0755 ${WSL_STUB_PATH}`

const STAGE_CODEX_LINK_IF_MISSING_SCRIPT =
  `if [ -e ${WSL_STUB_AGENT_LINK} ] || [ -L ${WSL_STUB_AGENT_LINK} ]; then ` +
  `printf existing; else ln -s ${WSL_STUB_PATH} ${WSL_STUB_AGENT_LINK} && printf created; fi`

function buildRestoreScript(stage: WslGoldenStubAgentStage): string {
  const removed = stage.createdCodexLink ? `${WSL_STUB_AGENT_LINK} ${WSL_STUB_PATH}` : WSL_STUB_PATH
  const restore = stage.backedUpStub ? ` && mv ${WSL_STUB_BACKUP_PATH} ${WSL_STUB_PATH}` : ''
  return `rm -f ${removed}${restore}`
}

// --exec prevents wsl.exe from expanding shell variables in argv.
function runInWslAsRoot(distro: string, script: string): string {
  return execFileSync(
    'wsl.exe',
    ['-u', 'root', ...buildWslExecArgs(distro, ['sh', '-c', script])],
    { encoding: 'utf8', stdio: 'pipe', windowsHide: true }
  )
}

export async function getFirstWslDistro(page: Page): Promise<string | null> {
  const wsl = await page.evaluate(async () => ({
    available: await window.api.wsl.isAvailable(),
    distros: await window.api.wsl.listDistros()
  }))
  return wsl.available ? (wsl.distros[0] ?? null) : null
}

export type WslGoldenStubAgentStage = {
  createdCodexLink: boolean
  backedUpStub: boolean
  ownsStubPath: boolean
}

/** Returns null when the distro cannot stage the stub. */
export function stageWslGoldenStubAgent(distro: string): WslGoldenStubAgentStage | null {
  const stage: WslGoldenStubAgentStage = {
    createdCodexLink: false,
    backedUpStub: false,
    ownsStubPath: false
  }
  try {
    stage.backedUpStub = runInWslAsRoot(distro, BACKUP_EXISTING_STUB_SCRIPT).trim() === 'backed-up'
    stage.ownsStubPath = true
    runInWslAsRoot(distro, STAGE_SCRIPT)
    stage.createdCodexLink =
      runInWslAsRoot(distro, STAGE_CODEX_LINK_IF_MISSING_SCRIPT).trim() === 'created'
    return stage
  } catch {
    removeWslGoldenStubAgent(distro, stage)
    return null
  }
}

export function removeWslGoldenStubAgent(distro: string, stage: WslGoldenStubAgentStage): void {
  if (!stage.ownsStubPath) {
    return
  }
  try {
    runInWslAsRoot(distro, buildRestoreScript(stage))
  } catch {
    // Best-effort cleanup; a leftover stub only affects this fixture's own name.
  }
}

/** Retargets project agent detection and terminal spawning to WSL. */
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

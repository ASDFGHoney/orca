import type { Page } from '@stablyai/playwright-test'

import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetControlCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { test, expect } from './helpers/orca-app'
import {
  readSta4746Probe,
  sta4746ProbeCommand,
  type Sta4746Probe
} from './helpers/sta4746-cwd-probe'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const REMOTE_FOLDER_PARENT = '/srv/sta4746'
const REMOTE_FOLDER_PATH = `${REMOTE_FOLDER_PARENT}/workspace`
const REMOTE_PROFILE_CD_PATH = `${REMOTE_FOLDER_PARENT}/container-init`
// Why: the profile script records where each login shell *started*, before it
// cd's. That is independent of OLDPWD, which a test could otherwise inherit.
const REMOTE_PRE_CD_LOG = `${REMOTE_FOLDER_PARENT}/pre-cd.log`

async function probeWorkspaceTerminal(
  page: Page,
  workspaceKey: string,
  phase: string
): Promise<Sta4746Probe> {
  await page.evaluate((key) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setActiveWorktree(key)
    const tab = store.getState().createTab(key, undefined, undefined, { activate: true })
    store.getState().setActiveTab(tab.id)
    store.getState().setActiveTabType('terminal')
  }, workspaceKey)
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  const ptyId = await waitForActivePanePtyId(page, 60_000)
  // Why: a local-provider fallback would satisfy every path assertion below,
  // because the container paths do not exist on the client. Pin the owner.
  expect(ptyId, `phase ${phase} did not get an SSH-owned PTY`).toMatch(/^ssh:[^@]+@@/)
  await focusActiveTerminalInput(page)
  // `readlink /proc/$$/cwd` is the kernel's answer for this exact shell, so it
  // is a second signal that cannot agree with $PWD by construction.
  await page.keyboard.type(sta4746ProbeCommand(phase, { selfcwd: '"$(readlink /proc/$$/cwd)"' }))
  await page.keyboard.press('Enter')
  return readSta4746Probe(page, phase)
}

test.describe('STA-4746 SSH relay folder workspace cwd', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the Docker SSH relay repro')

  test('relay honours the folder-workspace path; a login-profile cd is what moves it', async ({
    orcaPage: page
  }, testInfo) => {
    test.setTimeout(420_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      execDockerSshRelayTargetControlCommand(
        target,
        `mkdir -p ${REMOTE_FOLDER_PATH} ${REMOTE_PROFILE_CD_PATH}`
      )
      await waitForSessionReady(page)
      await waitForActiveWorktree(page)
      const connected = await connectDockerSshRelayTarget(page, target)
      const connectionId = connected.targetId
      const gitWorktreeKey = connected.worktreeId

      const folderWorkspaceId = await page.evaluate(
        async ({ connectionId, parentPath, folderPath }) => {
          const group = await window.api.projectGroups.create({
            name: `sta4746-${Date.now()}`,
            parentPath,
            connectionId,
            createdFrom: 'manual'
          })
          const workspace = await window.api.folderWorkspaces.create({
            projectGroupId: group.id,
            name: 'sta4746-ws',
            folderPath,
            connectionId
          })
          return workspace.id as string
        },
        { connectionId, parentPath: REMOTE_FOLDER_PARENT, folderPath: REMOTE_FOLDER_PATH }
      )
      const workspaceKey = `folder:${folderWorkspaceId}`
      await expect
        .poll(
          async () =>
            page.evaluate(
              (id) =>
                (window.__store?.getState().folderWorkspaces ?? []).some(
                  (workspace) => workspace.id === id
                ),
              folderWorkspaceId
            ),
          { timeout: 30_000, message: 'folder workspace never landed in the renderer store' }
        )
        .toBe(true)

      // Phase A — clean remote login profile. The relay must land in the folder path.
      const clean = await probeWorkspaceTerminal(page, workspaceKey, 'clean-folder')
      expect(clean.pwd).toBe(REMOTE_FOLDER_PATH)
      expect(clean.selfcwd).toBe(REMOTE_FOLDER_PATH)
      expect(clean.root).toBe(REMOTE_FOLDER_PATH)
      expect(clean.wt).toBe(workspaceKey)

      // Phase B — the relay spawns POSIX *login* shells, so a remote
      // /etc/profile.d entry that cd's wins over the spawn cwd. This is the
      // STA-4746 reporter's exact signature, with no Orca defect involved.
      execDockerSshRelayTargetControlCommand(
        target,
        `printf 'printf "%%s\\\\n" "$PWD" >> ${REMOTE_PRE_CD_LOG}\\ncd ${REMOTE_PROFILE_CD_PATH}\\n' > /etc/profile.d/99-sta4746-cd.sh`
      )
      const profiled = await probeWorkspaceTerminal(page, workspaceKey, 'profile-cd-folder')
      expect(profiled.pwd).toBe(REMOTE_PROFILE_CD_PATH)
      expect(profiled.selfcwd).toBe(REMOTE_PROFILE_CD_PATH)
      expect(profiled.oldpwd).toBe(REMOTE_FOLDER_PATH)
      expect(profiled.root).toBe(REMOTE_FOLDER_PATH)
      const folderPreCd = execDockerSshRelayTargetControlCommand(
        target,
        `tail -n 1 ${REMOTE_PRE_CD_LOG}`
      )
      expect(folderPreCd.trim()).toBe(REMOTE_FOLDER_PATH)

      // Phase C — the same login-profile cd moves a plain git worktree too, so
      // the symptom is not specific to `folder:<uuid>` workspace ids.
      const profiledWorktree = await probeWorkspaceTerminal(
        page,
        gitWorktreeKey,
        'profile-cd-worktree'
      )
      expect(profiledWorktree.pwd).toBe(REMOTE_PROFILE_CD_PATH)
      expect(profiledWorktree.oldpwd).toBe(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
      expect(profiledWorktree.root).toBe('')
      const worktreePreCd = execDockerSshRelayTargetControlCommand(
        target,
        `tail -n 1 ${REMOTE_PRE_CD_LOG}`
      )
      expect(worktreePreCd.trim()).toBe(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})

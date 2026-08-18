import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetControlCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import type { Page } from '@stablyai/playwright-test'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const REMOTE_FOLDER_PARENT = '/srv/sta4746'
const REMOTE_FOLDER_PATH = `${REMOTE_FOLDER_PARENT}/workspace`
const REMOTE_PROFILE_CD_PATH = `${REMOTE_FOLDER_PARENT}/container-init`
const PROBE = 'STA4746SSH'

async function probeWorkspaceTerminal(
  page: Page,
  workspaceKey: string,
  phase: string
): Promise<string> {
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
  await waitForActivePanePtyId(page, 60_000)
  await focusActiveTerminalInput(page)
  await page.keyboard.type(
    `printf '${PROBE} phase=${phase} pwd=%s oldpwd=%s wt=%s root=%s\\n' "$PWD" "$OLDPWD" "$ORCA_WORKTREE_ID" "$ORCA_WORKSPACE_ROOT"`
  )
  await page.keyboard.press('Enter')
  let observed = ''
  await expect
    .poll(
      async () => {
        const content = await getTerminalContent(page, 12_000)
        observed =
          content
            .split('\n')
            .toReversed()
            .find(
              (line) => line.includes(`${PROBE} phase=${phase} pwd=`) && !line.includes('printf')
            )
            ?.trim() ?? ''
        return observed
      },
      { timeout: 90_000, message: `probe line for phase ${phase} never rendered` }
    )
    .not.toBe('')
  console.log(`[sta4746-ssh] ${phase}:`, observed)
  return observed
}

test.describe('STA-4746 SSH relay folder workspace cwd', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the Docker SSH relay repro')

  test('relay honours the folder-workspace path; a login-profile cd is the only thing that moves it', async ({
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
      expect(clean).toContain(`pwd=${REMOTE_FOLDER_PATH}`)
      expect(clean).toContain(`root=${REMOTE_FOLDER_PATH}`)
      expect(clean).toContain(`wt=${workspaceKey}`)

      // Independent signal: the real process cwd on the remote host.
      const cleanRemoteCwds = execDockerSshRelayTargetControlCommand(
        target,
        `for p in $(pgrep -x bash 2>/dev/null); do d=$(readlink /proc/$p/cwd 2>/dev/null); [ -n "$d" ] && echo "$d"; done | sort -u`
      )
      console.log(`[sta4746-ssh] remote bash cwds (clean):\n${cleanRemoteCwds}`)
      expect(cleanRemoteCwds).toContain(REMOTE_FOLDER_PATH)

      // Phase B — the relay spawns POSIX *login* shells, so a remote /etc/profile.d
      // entry that cd's wins over the spawn cwd. This is the STA-4746 reporter's
      // exact signature (PWD=<other>, OLDPWD=<workspace>), with no Orca defect.
      execDockerSshRelayTargetControlCommand(
        target,
        `printf 'cd ${REMOTE_PROFILE_CD_PATH}\\n' > /etc/profile.d/99-sta4746-cd.sh`
      )
      const profiled = await probeWorkspaceTerminal(page, workspaceKey, 'profile-cd-folder')
      expect(profiled).toContain(`pwd=${REMOTE_PROFILE_CD_PATH}`)
      expect(profiled).toContain(`oldpwd=${REMOTE_FOLDER_PATH}`)
      expect(profiled).toContain(`root=${REMOTE_FOLDER_PATH}`)

      // Phase C — the same login-profile cd moves a plain git worktree too, so the
      // symptom is not specific to `folder:<uuid>` workspace ids.
      const profiledWorktree = await probeWorkspaceTerminal(
        page,
        gitWorktreeKey,
        'profile-cd-worktree'
      )
      expect(profiledWorktree).toContain(`pwd=${REMOTE_PROFILE_CD_PATH}`)
      expect(profiledWorktree).toContain(`oldpwd=${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}`)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'

import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const PROBE = 'STA4746PAIRED'

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
    `printf '${PROBE} phase=${phase} pwd=%s wt=%s root=%s\\n' "$PWD" "$ORCA_WORKTREE_ID" "$ORCA_WORKSPACE_ROOT"; touch ./${PROBE}-${phase}.marker`
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
      { timeout: 60_000, message: `probe line for phase ${phase} never rendered` }
    )
    .not.toBe('')
  console.log(`[sta4746-paired] ${phase}:`, observed)
  return observed
}

test('STA-4746: paired desktop client lands a folder-workspace PTY on the host folder path @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)

  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sta4746-paired-')))
  const folderPath = path.join(parent, 'workspace')
  mkdirSync(folderPath, { recursive: true })

  const hostWorktreeId = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const id = state?.activeWorktreeId
    const active = state?.allWorktrees().find((candidate) => candidate.id === id)
    if (!active) {
      throw new Error('Headed host did not select its seeded worktree')
    }
    return active.id
  })

  const folderWorkspaceId = await orcaPage.evaluate(
    async ({ parentPath, folderPath }) => {
      const group = await window.api.projectGroups.create({
        name: `sta4746-${Date.now()}`,
        parentPath,
        createdFrom: 'manual'
      })
      const workspace = await window.api.folderWorkspaces.create({
        projectGroupId: group.id,
        name: 'sta4746-ws',
        folderPath
      })
      return workspace.id as string
    },
    { parentPath: parent, folderPath }
  )
  const workspaceKey = `folder:${folderWorkspaceId}`

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'sta4746-client')
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) =>
              (window.__store?.getState().folderWorkspaces ?? []).some(
                (workspace) => workspace.id === id
              ),
            folderWorkspaceId
          ),
        { timeout: 60_000, message: 'client never mirrored the host folder workspace' }
      )
      .toBe(true)

    // Primary: the paired CLIENT drives the terminal; the HOST owns the PTY.
    const folderProbe = await probeWorkspaceTerminal(client.page, workspaceKey, 'client-folder')
    expect(folderProbe).toContain(`pwd=${folderPath}`)
    expect(folderProbe).toContain(`root=${folderPath}`)
    expect(folderProbe).toContain(`wt=${workspaceKey}`)
    // Independent filesystem signal: the marker landed in the folder path itself.
    await expect
      .poll(() => existsSync(path.join(folderPath, `${PROBE}-client-folder.marker`)), {
        timeout: 30_000,
        message: 'client folder-workspace PTY never wrote its marker into the folder path'
      })
      .toBe(true)

    // Control: a normal git worktree over the same paired transport.
    const worktreeProbe = await probeWorkspaceTerminal(
      client.page,
      hostWorktreeId,
      'client-worktree'
    )
    expect(worktreeProbe).toContain(`wt=${hostWorktreeId}`)
    expect(worktreeProbe).not.toContain(`pwd=${os.homedir()}\n`)

    // Control: local-only on the host itself, same folder workspace.
    const localProbe = await probeWorkspaceTerminal(orcaPage, workspaceKey, 'host-local-folder')
    expect(localProbe).toContain(`pwd=${folderPath}`)
    expect(localProbe).toContain(`root=${folderPath}`)
  } finally {
    await client.dispose()
    rmSync(parent, { recursive: true, force: true })
  }
})

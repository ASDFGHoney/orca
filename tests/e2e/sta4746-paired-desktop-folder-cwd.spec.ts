import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'

import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  readSta4746Probe,
  sta4746ProbeCommand,
  STA4746_PROBE,
  type Sta4746Probe
} from './helpers/sta4746-cwd-probe'
import { ensureTerminalVisible } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

async function probeWorkspaceTerminal(
  page: Page,
  workspaceKey: string,
  phase: string,
  expectedPtyOwner: RegExp
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
  // Why: host and client share one filesystem in this harness, so a
  // client-local fallback would satisfy every path assertion. Pin the owner so
  // the run proves the HOST spawned the PTY.
  expect(ptyId, `phase ${phase} did not get the expected PTY owner`).toMatch(expectedPtyOwner)
  await focusActiveTerminalInput(page)
  await page.keyboard.type(
    `${sta4746ProbeCommand(phase)}; touch ./${STA4746_PROBE}-${phase}.marker`
  )
  await page.keyboard.press('Enter')
  return readSta4746Probe(page, phase)
}

test('STA-4746: paired desktop client lands a folder-workspace PTY on the host folder path @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)

  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sta4746-paired-')))
  const folderPath = path.join(parent, 'workspace')
  mkdirSync(folderPath, { recursive: true })

  const hostWorktree = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const id = state?.activeWorktreeId
    const active = state?.allWorktrees().find((candidate) => candidate.id === id)
    if (!active) {
      throw new Error('Headed host did not select its seeded worktree')
    }
    return { id: active.id, path: active.path }
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
    const folderProbe = await probeWorkspaceTerminal(
      client.page,
      workspaceKey,
      'client-folder',
      /^remote:[^@]+@@/
    )
    expect(folderProbe.pwd).toBe(folderPath)
    expect(folderProbe.root).toBe(folderPath)
    expect(folderProbe.wt).toBe(workspaceKey)
    // Independent filesystem signal: the marker landed in the folder path itself.
    await expect
      .poll(() => existsSync(path.join(folderPath, `${STA4746_PROBE}-client-folder.marker`)), {
        timeout: 30_000,
        message: 'client folder-workspace PTY never wrote its marker into the folder path'
      })
      .toBe(true)

    // Control: a normal git worktree over the same paired transport.
    const worktreeProbe = await probeWorkspaceTerminal(
      client.page,
      hostWorktree.id,
      'client-worktree',
      /^remote:[^@]+@@/
    )
    expect(worktreeProbe.wt).toBe(hostWorktree.id)
    expect(worktreeProbe.pwd).toBe(hostWorktree.path)
    expect(worktreeProbe.root).toBe('')

    // Control: local-only on the host itself, same folder workspace.
    const localProbe = await probeWorkspaceTerminal(
      orcaPage,
      workspaceKey,
      'host-local-folder',
      /^folder:[^@]+@@/
    )
    expect(localProbe.pwd).toBe(folderPath)
    expect(localProbe.root).toBe(folderPath)
  } finally {
    await client.dispose()
    rmSync(parent, { recursive: true, force: true })
  }
})

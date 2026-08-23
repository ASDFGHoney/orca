import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'

const WINDOWS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
const ORCHESTRATION_INSTALL_COMMAND =
  'npx skills add https://github.com/stablyai/orca --skill orchestration --global'

async function expectHostPlatformCommand(
  app: ElectronApplication,
  offer: RuntimeDesktopPairingOffer,
  show: boolean
): Promise<void> {
  const client = await launchPairedWebClient(app, offer, {
    show,
    userAgent: WINDOWS_USER_AGENT,
    waitForWorkspace: false
  })
  try {
    await client.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 30_000 }
    )
    const platforms = await client.page.evaluate(async () => ({
      host: (await window.api.runtime.getStatus()).hostPlatform,
      viewer: window.api.platform.get().platform
    }))
    expect(platforms).toEqual({ host: process.platform, viewer: 'win32' })

    await openOrchestrationSettings(client.page)
    await client.page.getByRole('button', { name: 'Copy install command' }).click()
    const command = client.page.getByRole('dialog').locator('p.font-mono')
    await expect(command).toBeVisible()
    await expect(command).toHaveText(ORCHESTRATION_INSTALL_COMMAND)
  } finally {
    await client.dispose()
  }
}

async function openOrchestrationSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByPlaceholder('Search settings')).toBeVisible()
  await page.getByRole('button', { name: 'Orchestration', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copy install command' })).toBeVisible()
}

test('uses headed paired host platform for skill commands @headful', async ({
  electronApp,
  orcaPage
}) => {
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  await expectHostPlatformCommand(electronApp, offer, true)
})

test('uses headless paired host platform for skill commands', async () => {
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    await expectHostPlatformCommand(host.app, host.offer, false)
  } finally {
    await host.dispose()
  }
})

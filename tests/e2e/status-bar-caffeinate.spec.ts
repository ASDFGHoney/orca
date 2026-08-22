import { randomUUID } from 'node:crypto'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { waitForStartupFocusToSettle } from './helpers/status-bar-menu'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'

async function postCodexHookEvent(
  electronApp: ElectronApplication,
  paneKey: string,
  eventName: 'UserPromptSubmit' | 'Stop'
): Promise<void> {
  const endpoint = await readHookEndpoint(electronApp)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey,
      tabId: 'e2e-caffeinate-tab',
      worktreeId: 'e2e-caffeinate-worktree',
      env: endpoint.env,
      version: endpoint.version,
      payload: { hook_event_name: eventName, prompt: 'e2e caffeinate prompt' }
    })
  })
  expect(response.status).toBe(204)
}

test('shows Caffeinate mode and Agent activity in the status bar', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)

  await waitForStartupFocusToSettle(orcaPage)
  const offStatus = orcaPage.getByRole('button', { name: 'Caffeinate, Off · Inactive' })
  await expect(offStatus).toBeVisible()
  await expect(offStatus).toHaveText('Off')
  await offStatus.click()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^On/ })).toBeVisible()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^Agent/ })).toBeVisible()
  await expect(orcaPage.getByRole('menuitemradio', { name: /^Off/ })).toBeVisible()
  const menuProofPath = process.env.ORCA_CAFFEINATE_MENU_PROOF_PATH
  if (menuProofPath) {
    await orcaPage.getByRole('menu').screenshot({ path: menuProofPath, animations: 'disabled' })
  }
  await orcaPage.getByRole('menuitemradio', { name: /^Agent/ }).click()

  const agentInactiveStatus = orcaPage.getByRole('button', {
    name: 'Caffeinate, Agent · Inactive'
  })
  await expect(agentInactiveStatus).toBeVisible()

  const paneKey = `e2e-caffeinate-tab:${randomUUID()}`
  await postCodexHookEvent(electronApp, paneKey, 'UserPromptSubmit')
  const agentActiveStatus = orcaPage.getByRole('button', {
    name: 'Caffeinate, Agent · Active'
  })
  await expect(agentActiveStatus).toBeVisible()
  await expect(agentActiveStatus).toHaveText('Agent')

  const proofPath = process.env.ORCA_CAFFEINATE_PROOF_PATH
  if (proofPath) {
    await orcaPage.screenshot({ path: proofPath })
  }

  await postCodexHookEvent(electronApp, paneKey, 'Stop')
  await expect(agentInactiveStatus).toBeVisible()
})

/** Radix scales the tooltip in, so measure only once its box stops changing. */
async function waitForStableBox(locator: Locator): Promise<void> {
  let previous = ''
  await expect
    .poll(
      async () => {
        const box = JSON.stringify(await locator.boundingBox())
        const stable = box === previous
        previous = box
        return stable
      },
      { timeout: 5_000 }
    )
    .toBe(true)
}

/**
 * Region around the open menu, widened up and left to take in a tooltip.
 *
 * Anchored on the menu rather than the tooltip's own box: Radix portals the
 * tooltip and transforms it into place, so its reported geometry lags the paint.
 */
async function menuWithTooltipClip(
  page: Page
): Promise<{ x: number; y: number; width: number; height: number }> {
  const menu = await page.getByRole('menu').boundingBox()
  if (!menu) {
    throw new Error('menu is not open')
  }
  const growLeft = 330
  const growUp = 200
  const growRight = 90
  const pad = 10
  return {
    x: Math.max(0, menu.x - growLeft),
    y: Math.max(0, menu.y - growUp),
    width: menu.width + growLeft + growRight,
    height: menu.height + growUp + pad
  }
}

// Amphetamine is a macOS-only engine, so the picker only exists there.
test('offers the macOS keep-awake engine picker in the status bar', async ({ orcaPage }) => {
  test.skip(process.platform !== 'darwin', 'the engine picker is macOS only')
  await waitForSessionReady(orcaPage)

  await waitForStartupFocusToSettle(orcaPage)
  await orcaPage.getByRole('button', { name: 'Caffeinate, Off · Inactive' }).click()
  const engines = orcaPage.getByRole('radiogroup', { name: 'Keep awake engine' })
  const caffeinateEngine = engines.getByRole('radio', { name: 'Caffeinate' })
  const amphetamineEngine = engines.getByRole('radio', { name: 'Amphetamine' })
  await expect(caffeinateEngine).toBeVisible()
  await expect(amphetamineEngine).toBeVisible()
  await expect(caffeinateEngine).toHaveAttribute('aria-checked', 'true')

  // The tooltips are how the two engines explain themselves, so assert their
  // substance rather than just their presence.
  await amphetamineEngine.hover()
  const amphetamineTip = orcaPage.getByRole('tooltip').filter({ hasText: 'Amphetamine' })
  await expect(amphetamineTip).toBeVisible()
  await expect(amphetamineTip).toContainText('Amphetamine Mac app')
  await expect(amphetamineTip).toContainText('never replaces or ends')

  const tooltipProof = process.env.ORCA_AWAKE_ENGINE_TOOLTIP_PROOF_PATH
  if (tooltipProof) {
    await waitForStableBox(amphetamineTip)
    await orcaPage.screenshot({
      path: tooltipProof,
      clip: await menuWithTooltipClip(orcaPage),
      animations: 'disabled'
    })
  }

  await caffeinateEngine.hover()
  await expect(orcaPage.getByRole('tooltip').filter({ hasText: 'Built into macOS' })).toBeVisible()

  const enginePathProof = process.env.ORCA_AWAKE_ENGINE_MENU_PROOF_PATH
  if (enginePathProof) {
    // Screenshot the menu itself: it is taller than the viewport leaves room for.
    await orcaPage.getByRole('menu').screenshot({ path: enginePathProof, animations: 'disabled' })
  }

  // A host without Amphetamine installed routes the click to the App Store
  // listing instead of selecting a dead engine, so stop here.
  if (!(await amphetamineEngine.isEnabled())) {
    return
  }
  await amphetamineEngine.click()
  // The engine buttons are not menu items, so switching engine leaves the menu
  // open and the mode is still one click away.
  await expect(amphetamineEngine).toHaveAttribute('aria-checked', 'true')
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: /^Amphetamine, Off/ })).toBeVisible()

  const engineSelectedProof = process.env.ORCA_AWAKE_ENGINE_SELECTED_PROOF_PATH
  if (engineSelectedProof) {
    await orcaPage
      .getByRole('menu')
      .screenshot({ path: engineSelectedProof, animations: 'disabled' })
  }
})

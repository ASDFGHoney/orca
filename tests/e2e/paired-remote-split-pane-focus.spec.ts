/**
 * A client-initiated split on a paired remote workspace never runs the local
 * splitManagedPane focus; the pane arrives later from the host's session-tabs
 * mirror, focused only if the client claimed its leaf first (#16510).
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT } from '../../src/renderer/src/constants/terminal'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForActivePanePtyId, waitForPaneCount } from './helpers/terminal'

async function showClient(app: ElectronApplication, page: Page): Promise<void> {
  const clientWindow = await app.browserWindow(page)
  await clientWindow.evaluate((window) => {
    window.show()
    window.focus()
  })
  await expect.poll(() => clientWindow.evaluate((window) => window.isVisible())).toBe(true)
}

async function waitForClientWorktree(page: Page, expectedId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.id === id)?.id ?? null,
          expectedId
        ),
      { timeout: 30_000 }
    )
    .toBe(expectedId)
}

test('focuses the pane a client split creates on a paired remote workspace', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(150_000)
  const hostWorktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!hostWorktreeId) {
    throw new Error('Headed host has no active seeded workspace')
  }
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'paired-split-focus-client')
  try {
    await showClient(client.app, client.page)
    await waitForClientWorktree(client.page, hostWorktreeId)

    const created = await client.page.evaluate(
      async ({ selector, worktreeId }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector,
          method: 'session.tabs.createTerminal',
          params: {
            worktree: `id:${worktreeId}`,
            activate: false,
            select: false,
            navigation: 'caller'
          }
        })
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
        return response.result as { tab: { parentTabId: string } }
      },
      { selector: client.environmentId, worktreeId: hostWorktreeId }
    )

    const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await client.page.evaluate(
      (id) => window.__store?.getState().setActiveWorktree(id),
      hostWorktreeId
    )
    const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    await expect(tab).toHaveAttribute('data-active', 'true')

    const sourcePtyId = await waitForActivePanePtyId(client.page, 30_000)
    await waitForPaneCount(client.page, 1)

    // Why: the same helper Cmd+D reaches, so this exercises splitWebRuntimeTerminal
    // rather than driving the PaneManager past it.
    await client.page.evaluate(
      ({ eventName, tabId }) => {
        window.dispatchEvent(
          new CustomEvent(eventName, { detail: { tabId, direction: 'vertical' } })
        )
      },
      { eventName: REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT, tabId: webTabId }
    )

    await waitForPaneCount(client.page, 2, 30_000)
    const focusedPtyId = await waitForActivePanePtyId(client.page, 30_000)
    expect(focusedPtyId).not.toBe(sourcePtyId)
  } finally {
    await client.dispose()
  }
})

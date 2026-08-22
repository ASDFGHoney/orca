import type { ElectronApplication, Page } from '@stablyai/playwright-test'

/**
 * Paired clients launch with ORCA_E2E_HEADLESS=1, so their main window is created with
 * `show: false` and never revealed. That is real product behaviour, not a harness artifact: a
 * never-shown window keeps `document.visibilityState` at 'hidden', so the renderer parks its
 * runtime subscriptions (`installWindowVisibilitySubscriptionParking`) and stops the runtime
 * heartbeat (`installWindowVisibilityInterval`), which leaves host-scoped UI such as the Add
 * Project dialog reporting a disconnected host with its actions disabled — exactly what a user who
 * cannot see the window gets.
 *
 * A spec that drives that window with Playwright is asserting against a state the product never
 * presents for interaction. Reveal the client first; leave it hidden only when the hidden state is
 * what the spec covers (parked panes, park/reveal interactivity). Revealing the Playwright-driven
 * client says nothing about the HUB, so hidden-window host topologies keep their coverage.
 */
export type PairedClientWindowRevealReport = {
  isVisible: boolean
  wasVisible: boolean
  windowCount: number
}

export type RevealablePairedClient = {
  app: ElectronApplication
  page: Page
}

export function assertPairedClientWindowRevealed(report: PairedClientWindowRevealReport): void {
  if (report.windowCount === 0) {
    throw new Error('Paired client has no BrowserWindow to reveal')
  }
  if (!report.isVisible) {
    throw new Error(
      `Paired client window stayed hidden after show() (windows: ${report.windowCount})`
    )
  }
}

export async function revealPairedClientWindow(
  client: RevealablePairedClient
): Promise<PairedClientWindowRevealReport> {
  const report = await client.app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const window = windows[0]
    const wasVisible = window?.isVisible() ?? false
    if (window && !wasVisible) {
      window.show()
    }
    return {
      isVisible: window?.isVisible() ?? false,
      wasVisible,
      windowCount: windows.length
    }
  })
  assertPairedClientWindowRevealed(report)
  // Why: the renderer resumes parked work from `visibilitychange`, so a caller that clicks before
  // the reveal reaches the document races a still-parked host list.
  await client.page.waitForFunction(() => document.visibilityState === 'visible', null, {
    timeout: 30_000
  })
  return report
}

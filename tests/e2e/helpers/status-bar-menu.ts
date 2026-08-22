import type { Page } from '@stablyai/playwright-test'

/**
 * Wait for the composer's post-startup autofocus before opening a status-bar menu.
 *
 * The status-bar dropdowns are non-modal, so the late focus grab closes one that
 * is already open. Letting focus settle first removes the race instead of
 * papering over it with a fixed delay.
 */
export async function waitForStartupFocusToSettle(page: Page): Promise<void> {
  await page
    .waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', undefined, {
      timeout: 15_000
    })
    .catch(() => {
      // No composer on this screen; nothing will steal focus.
    })
}

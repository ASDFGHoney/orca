import type { BrowserClientAutomationMethod } from '../../shared/browser-client-automation-protocol'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import {
  assertBrowserClientPageCommandNotAborted,
  assertCurrentBrowserClientPageRenderer
} from './browser-client-page-command-admission'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'
import { sameBrowserClientPageAuthority } from './browser-client-host-command-authority'
import type {
  BrowserClientPageLifecycleRegistry,
  BrowserClientRetainedPage
} from './browser-client-page-retained-state'
import { updateBrowserClientPageInventoryCurrentUrl } from './browser-client-page-inventory'

export async function navigateBrowserClientPageCommand(
  pages: Map<string, BrowserClientRetainedPage>,
  routeWebContents: BrowserClientPageLifecycleRegistry,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal
): Promise<void> {
  if (event.command.type !== 'navigate') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  const page = requireCommandPage(pages, event)
  assertBrowserClientPageCommandNotAborted(signal)
  assertCurrentBrowserClientPageRenderer(page.renderer)
  const normalized = normalizeBrowserNavigationUrl(event.command.url)
  if (!normalized || normalized.startsWith('file:')) {
    throw new BrowserClientPageCommandError('browser_client_page_navigation_invalid')
  }
  const navigated = await routeWebContents.navigateGuest(page.lifecycleClaim, normalized)
  if (!navigated) {
    throw new BrowserClientPageCommandError('browser_client_page_navigation_failed')
  }
  page.inventory = updateBrowserClientPageInventoryCurrentUrl(page.inventory, normalized)
}

export async function executeBrowserClientPageAutomationCommand(
  pages: Map<string, BrowserClientRetainedPage>,
  execute: (
    input: {
      browserPageId: string
      pageHostGeneration: number
      browserProfileId: string
      method: BrowserClientAutomationMethod
      params: Record<string, unknown>
      registration: BrowserClientRetainedPage['registration']
    },
    signal: AbortSignal
  ) => Promise<unknown>,
  event: BrowserClientHostCommandEvent,
  signal: AbortSignal
): Promise<unknown> {
  if (event.command.type !== 'automation') {
    throw new BrowserClientPageCommandError('browser_client_page_command_invalid')
  }
  const page = requireCommandPage(pages, event)
  assertBrowserClientPageCommandNotAborted(signal)
  assertCurrentBrowserClientPageRenderer(page.renderer)
  return execute(
    {
      browserPageId: event.browserPageId,
      pageHostGeneration: event.pageHostGeneration,
      browserProfileId: page.inventory.browserProfileId,
      method: event.command.method,
      params: event.command.params,
      registration: page.registration
    },
    signal
  )
}

function requireCommandPage(
  pages: Map<string, BrowserClientRetainedPage>,
  event: BrowserClientHostCommandEvent
): BrowserClientRetainedPage {
  const page = pages.get(event.browserPageId)
  if (
    !page ||
    page.generation !== event.pageHostGeneration ||
    page.retiring ||
    page.reconciling ||
    !sameBrowserClientPageAuthority(page.inventory, event)
  ) {
    throw new BrowserClientPageCommandError('browser_client_page_generation_stale')
  }
  return page
}

import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../shared/browser-client-automation-protocol'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { sameRuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import type { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type {
  RuntimeBrowserClientPage,
  RuntimeBrowserPageRegistry
} from './runtime-browser-page-registry'

const MAX_RECOVERY_CONCURRENCY = 4

type RecoveryAuthority = Pick<
  BrowserHostLeaseRegistry,
  | 'authorityRuntimeId'
  | 'authorityEpoch'
  | 'beginPageRetirement'
  | 'completePageRetirement'
  | 'createClientPage'
  | 'getPlacement'
> & {
  issueClientPageCommand(
    authority: {
      authorityRuntimeId: string
      authorityEpoch: string
      browserPageId: string
      browserHostClientId: string
      browserHostGeneration: number
      pageHostGeneration: number
    },
    command: BrowserClientHostCommandEvent['command']
  ): { result: Promise<BrowserClientHostCommandResult> }
}

export async function recoverUnavailableRuntimeBrowserClientPages(options: {
  lease: BrowserClientHostLeaseAuthority & {
    pairedDeviceId: string
    pageInventory?: readonly BrowserClientHostedPageInventory[]
  }
  authority: RecoveryAuthority
  pages: RuntimeBrowserPageRegistry
  notifyWorkspace(workspaceId: string): void
}): Promise<void> {
  const inventory = options.lease.pageInventory
  if (
    options.lease.pageReconciliationProtocolVersion !== 1 ||
    options.lease.pageInventoryProtocolVersion !== 1 ||
    !inventory
  ) {
    return
  }
  const inventoryByPageId = new Map(inventory.map((page) => [page.browserPageId, page]))
  const pages = options.pages
    .listPages()
    .filter(
      (page) =>
        page.placement.browserHostClientId === options.lease.browserHostClientId &&
        page.placement.browserHostGeneration === options.lease.browserHostGeneration &&
        !isActiveExactPage(page, inventoryByPageId.get(page.browserPageId), options.lease)
    )
  await mapWithConcurrency(pages, MAX_RECOVERY_CONCURRENCY, async (page) => {
    await recoverPage(page, inventoryByPageId.get(page.browserPageId), options)
  })
}

async function recoverPage(
  page: RuntimeBrowserClientPage,
  inventory: BrowserClientHostedPageInventory | undefined,
  options: Parameters<typeof recoverUnavailableRuntimeBrowserClientPages>[0]
): Promise<void> {
  const currentPlacement = options.authority.getPlacement(page.browserPageId)
  if (currentPlacement && !sameRuntimeBrowserPlacement(currentPlacement, page.placement)) {
    if (
      currentPlacement.kind === 'client' &&
      currentPlacement.browserHostClientId === options.lease.browserHostClientId &&
      currentPlacement.browserHostGeneration === options.lease.browserHostGeneration
    ) {
      options.pages.replaceClientPagePlacement(page.browserPageId, page.placement, currentPlacement)
      options.notifyWorkspace(page.workspaceId)
      return
    }
    throw new Error('browser_page_placement_stale')
  }
  if (currentPlacement) {
    if (inventory) {
      assertInventoryAuthority(page, inventory, options.lease)
      await closeUnavailablePage(options.authority, page)
    } else {
      const retirement = options.authority.beginPageRetirement(page.browserPageId, currentPlacement)
      if (!options.authority.completePageRetirement(retirement)) {
        throw new Error('browser_page_placement_stale')
      }
    }
  }
  const placement = await options.authority.createClientPage({
    browserPageId: page.browserPageId,
    browserHostClientId: options.lease.browserHostClientId,
    pairedDeviceId: options.lease.pairedDeviceId,
    browserProfileId: page.browserProfileId,
    executionHostKey: page.executionHostKey,
    requiredCapabilities: [BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY]
  })
  const recovered = options.pages.replaceClientPagePlacement(
    page.browserPageId,
    page.placement,
    placement
  )
  const url = inventory?.currentUrl ?? page.url
  if (url && url !== 'about:blank') {
    await navigateRecoveredPage(options.authority, page.browserPageId, placement, url)
    options.pages.updatePage(page.browserPageId, placement, { url, loading: false })
  } else if (recovered.loading) {
    options.pages.updatePage(page.browserPageId, placement, { loading: false })
  }
  options.notifyWorkspace(page.workspaceId)
}

async function closeUnavailablePage(
  authority: RecoveryAuthority,
  page: RuntimeBrowserClientPage
): Promise<void> {
  const issued = authority.issueClientPageCommand(
    commandAuthority(authority, page.browserPageId, page.placement),
    {
      type: 'closePage',
      targetAuthority: {
        authorityRuntimeId: authority.authorityRuntimeId,
        authorityEpoch: authority.authorityEpoch,
        browserHostClientId: page.placement.browserHostClientId,
        browserHostGeneration: page.placement.browserHostGeneration,
        pageHostGeneration: page.placement.pageHostGeneration
      }
    }
  )
  const result = await issued.result
  if (result.status === 'failed') {
    throw new Error(result.errorCode)
  }
  const currentPlacement = authority.getPlacement(page.browserPageId)
  if (!currentPlacement || !sameRuntimeBrowserPlacement(currentPlacement, page.placement)) {
    throw new Error('browser_page_placement_stale')
  }
  const retirement = authority.beginPageRetirement(page.browserPageId, currentPlacement)
  if (!authority.completePageRetirement(retirement)) {
    throw new Error('browser_page_placement_stale')
  }
}

async function navigateRecoveredPage(
  authority: RecoveryAuthority,
  browserPageId: string,
  placement: RuntimeBrowserClientPage['placement'],
  url: string
): Promise<void> {
  const issued = authority.issueClientPageCommand(
    commandAuthority(authority, browserPageId, placement),
    { type: 'navigate', url }
  )
  const result = await issued.result
  if (result.status === 'failed') {
    throw new Error(result.errorCode)
  }
}

function commandAuthority(
  authority: RecoveryAuthority,
  browserPageId: string,
  placement: RuntimeBrowserClientPage['placement']
) {
  return {
    authorityRuntimeId: authority.authorityRuntimeId,
    authorityEpoch: authority.authorityEpoch,
    browserPageId,
    browserHostClientId: placement.browserHostClientId,
    browserHostGeneration: placement.browserHostGeneration,
    pageHostGeneration: placement.pageHostGeneration
  }
}

function isActiveExactPage(
  page: RuntimeBrowserClientPage,
  inventory: BrowserClientHostedPageInventory | undefined,
  lease: BrowserClientHostLeaseAuthority
): boolean {
  return Boolean(
    inventory?.state === 'active' &&
    inventory.authorityRuntimeId === lease.authorityRuntimeId &&
    inventory.authorityEpoch === lease.authorityEpoch &&
    inventory.browserHostClientId === page.placement.browserHostClientId &&
    inventory.browserHostGeneration === page.placement.browserHostGeneration &&
    inventory.pageHostGeneration === page.placement.pageHostGeneration &&
    inventory.browserProfileId === page.browserProfileId &&
    inventory.executionHostKey === page.executionHostKey
  )
}

function assertInventoryAuthority(
  page: RuntimeBrowserClientPage,
  inventory: BrowserClientHostedPageInventory,
  lease: BrowserClientHostLeaseAuthority
): void {
  if (
    inventory.authorityRuntimeId !== lease.authorityRuntimeId ||
    inventory.authorityEpoch !== lease.authorityEpoch ||
    inventory.browserHostClientId !== page.placement.browserHostClientId ||
    inventory.browserHostGeneration !== page.placement.browserHostGeneration ||
    inventory.pageHostGeneration !== page.placement.pageHostGeneration
  ) {
    throw new Error('browser_client_page_reconciliation_authority_stale')
  }
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  let index = 0
  const worker = async (): Promise<void> => {
    while (index < values.length) {
      const value = values[index]
      index += 1
      if (value !== undefined) {
        await operation(value)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
}

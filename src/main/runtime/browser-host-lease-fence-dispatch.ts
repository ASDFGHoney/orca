import type { BrowserHostFenceReason } from './browser-host-lease-fence'
import { fenceBrowserHostLease } from './browser-host-lease-fencing'
import type { BrowserHostLeaseState, BrowserHostRouteState } from './browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from './browser-host-page-placement'

type BrowserHostLeaseFenceDependencies = {
  leasesByClientId: Map<string, BrowserHostLeaseState>
  pagePlacements: Pick<BrowserHostPagePlacementRegistry, 'fenceClientHostPlacements'>
  clearReconnect(state: BrowserHostLeaseState): void
  fenceReconciliation(state: BrowserHostLeaseState): void
  fenceRoute(route: BrowserHostRouteState, reason: BrowserHostFenceReason): void
  onClientPageReleased?: (browserPageId: string) => void
}

/** Retires one lease: its reconnect timer, reconciliation, pages, routes, and per-page state. */
export function dispatchBrowserHostLeaseFence(
  state: BrowserHostLeaseState,
  reason: BrowserHostFenceReason,
  dependencies: BrowserHostLeaseFenceDependencies
): void {
  dependencies.clearReconnect(state)
  if (dependencies.leasesByClientId.get(state.lease.browserHostClientId)?.token !== state.token) {
    return
  }
  dependencies.fenceReconciliation(state)
  const fencedPages = dependencies.pagePlacements.fenceClientHostPlacements({
    browserHostClientId: state.lease.browserHostClientId,
    browserHostGeneration: state.lease.browserHostGeneration
  })
  fenceBrowserHostLease(state, reason, dependencies.leasesByClientId, (route, routeReason) =>
    dependencies.fenceRoute(route, routeReason)
  )
  // Why: a fenced page never completes retirement through the client, so release its runtime-side
  // state here or it stays stranded for the life of the runtime.
  for (const browserPageId of fencedPages) {
    dependencies.onClientPageReleased?.(browserPageId)
  }
}

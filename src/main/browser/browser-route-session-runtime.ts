import { session, webContents } from 'electron'
import { setBrowserClientRouteWebContentsProbe } from './browser-client-download-routing'
import {
  configureBrowserRoutePartitionBindingsForOrcaProfile,
  currentBrowserRoutePartitionBindingStore
} from './browser-route-partition-binding-runtime'
import { isBrowserRouteGuestPopup } from './browser-route-guest-popup-ownership'
import { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'
import { browserSessionRegistry } from './browser-session-registry'

const routeWebContentsRegistryRef: {
  current: BrowserRouteWebContentsRegistry | null
} = { current: null }

const bindingStore = {
  get(partition: string): string | null {
    return currentBrowserRoutePartitionBindingStore().get(partition)
  },
  set(partition: string, fingerprint: string, storageScope: string): void {
    currentBrowserRoutePartitionBindingStore().set(partition, fingerprint, storageScope)
  }
}

export const browserRouteSessionRegistry = new BrowserRouteSessionRegistry({
  validateProfile: (browserProfileId) => {
    browserSessionRegistry.requireRouteBrowserProfile(browserProfileId)
  },
  getSession: (partition) => session.fromPartition(partition),
  setupPolicies: ({ partition, browserProfileId }) => {
    browserSessionRegistry.setupRoutePartitionPolicies(partition, browserProfileId)
  },
  clearPolicies: ({ partition }) => {
    browserSessionRegistry.clearRoutePartitionPolicies(partition)
  },
  retirePageAuthority: (retirement) =>
    routeWebContentsRegistryRef.current?.retirePageAuthority(retirement) ?? false,
  bindingStore
})

export const browserRouteWebContentsRegistry = new BrowserRouteWebContentsRegistry({
  getPartitionForSession: (routeSession) =>
    browserRouteSessionRegistry.getPartitionForSession(routeSession),
  getPreparedPageAuthority: (page) => browserRouteSessionRegistry.getPreparedPageAuthority(page),
  rekeyPreparedPage: (previous, next) =>
    browserRouteSessionRegistry.rekeyPreparedPage(previous, next),
  retirePreparedPage: (page) => browserRouteSessionRegistry.retirePreparedPage(page),
  retirePreparedPagesOwnedByRenderer: (rendererWebContentsId) =>
    browserRouteSessionRegistry.retirePreparedPagesOwnedByRenderer(rendererWebContentsId)
})
routeWebContentsRegistryRef.current = browserRouteWebContentsRegistry

// Why: downloads must fail closed for client-hosted content, so the router needs to tell a route
// guest (or one of its popups) from an ordinary browser guest before it decides where bytes land.
setBrowserClientRouteWebContentsProbe((webContentsId) => {
  if (isBrowserRouteGuestPopup(webContentsId)) {
    return true
  }
  const contents = webContents.fromId(webContentsId)
  return Boolean(
    contents &&
    !contents.isDestroyed() &&
    browserRouteSessionRegistry.getPartitionForSession(contents.session) !== null
  )
})

export function configureRouteSessionsForOrcaProfile(options: {
  orcaProfileId: string
  profileDirectory: string
}): void {
  configureBrowserRoutePartitionBindingsForOrcaProfile(options)
}

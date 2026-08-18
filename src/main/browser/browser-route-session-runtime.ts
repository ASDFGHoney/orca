import { session } from 'electron'
import {
  configureBrowserRoutePartitionBindingsForOrcaProfile,
  currentBrowserRoutePartitionBindingStore
} from './browser-route-partition-binding-runtime'
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

export function configureRouteSessionsForOrcaProfile(options: {
  orcaProfileId: string
  profileDirectory: string
}): void {
  configureBrowserRoutePartitionBindingsForOrcaProfile(options)
}

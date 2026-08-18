import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'
import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  selectBrowserProfile,
  type DetectedBrowser
} from './browser-cookie-import'
import { currentBrowserRoutePartitionBindingStore } from './browser-route-partition-binding-runtime'
import { deriveBrowserRoutePartition } from './browser-route-identity'
import { browserSessionRegistry } from './browser-session-registry'
import { getPairedRuntimeBrowserClientRouteIdentity } from './paired-runtime-browser-client-host-runtime'

export type ClientRouteCookieImportRequest = {
  environmentId: string
  browserProfileId: string
  browserFamily: string
  browserProfile?: string
}

/**
 * Imports desktop-browser cookies into the client-hosted route partition of a
 * paired server, or null when that server's pages are not client-hosted and the
 * caller should fall through to the server-side import RPC.
 *
 * The renderer names an environment and a browser session profile; main derives
 * and validates the partition, so no caller can address storage directly.
 */
export async function importCookiesIntoClientRoutePartition(
  request: ClientRouteCookieImportRequest
): Promise<BrowserCookieImportResult | null> {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(request.environmentId)
  if (!routeIdentity) {
    return null
  }
  const profile = browserSessionRegistry.getProfile(request.browserProfileId)
  if (!profile) {
    return { ok: false, reason: 'Session profile not found.' }
  }
  const browser = resolveImportSource(request)
  if ('reason' in browser) {
    return browser
  }
  let partition: string
  try {
    partition = bindRoutePartition(routeIdentity, request.browserProfileId)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const result = await importCookiesFromBrowser(browser.source, partition)
  if (!result.ok) {
    return result
  }
  browserSessionRegistry.updateProfileSource(request.browserProfileId, {
    browserFamily: browser.source.family,
    profileName: importedProfileName(browser.source),
    importedAt: Date.now()
  })
  return { ...result, profileId: request.browserProfileId }
}

function bindRoutePartition(
  routeIdentity: NonNullable<ReturnType<typeof getPairedRuntimeBrowserClientRouteIdentity>>,
  browserProfileId: string
): string {
  browserSessionRegistry.requireRouteBrowserProfile(browserProfileId)
  const derived = deriveBrowserRoutePartition({
    orcaProfileId: routeIdentity.orcaProfileId,
    browserProfileId,
    authorityConnectionIdentity: routeIdentity.authorityConnectionIdentity,
    executionHostIdentity: routeIdentity.executionHostIdentity
  })
  const bindings = currentBrowserRoutePartitionBindingStore()
  const persisted = bindings.get(derived.partition)
  if (persisted === null) {
    bindings.set(derived.partition, derived.bindingFingerprint, routeIdentity.storageScope)
  } else if (persisted !== derived.bindingFingerprint) {
    throw new Error('browser_route_partition_binding_conflict')
  }
  return derived.partition
}

function resolveImportSource(
  request: ClientRouteCookieImportRequest
): { source: DetectedBrowser } | { ok: false; reason: string } {
  // Why: browserProfile reaches a filesystem path, so reject traversal before use.
  if (
    request.browserProfile &&
    (/[/\\]/.test(request.browserProfile) || request.browserProfile.includes('..'))
  ) {
    return { ok: false, reason: 'Invalid browser profile name.' }
  }
  const browser = detectInstalledBrowsers().find((entry) => entry.family === request.browserFamily)
  if (!browser) {
    return { ok: false, reason: 'Browser not found on this system.' }
  }
  if (!request.browserProfile || request.browserProfile === browser.selectedProfile) {
    return { source: browser }
  }
  const reselected = selectBrowserProfile(browser, request.browserProfile)
  if (!reselected) {
    return {
      ok: false,
      reason: `No cookies database found for profile "${request.browserProfile}".`
    }
  }
  return { source: reselected }
}

function importedProfileName(browser: DetectedBrowser): string {
  return (
    browser.profiles.find((entry) => entry.directory === browser.selectedProfile)?.name ??
    browser.selectedProfile
  )
}

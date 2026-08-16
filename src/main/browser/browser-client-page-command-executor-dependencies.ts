import type { BrowserClientAutomationMethod } from '../../shared/browser-client-automation-protocol'
import type {
  BrowserClientPageNetworkRoute,
  BrowserClientPageRenderer
} from './browser-client-page-cleanup'
import type { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import type {
  BrowserClientPageLifecycleRegistry,
  BrowserClientRetainedPage
} from './browser-client-page-retained-state'

export type BrowserClientPageCommandExecutorDependencies = {
  orcaProfileId: string
  authorityConnectionIdentity: string
  retainNetworkRoute(
    executionHostKey: string,
    signal: AbortSignal
  ): Promise<BrowserClientPageNetworkRoute>
  selectRenderer(): BrowserClientPageRenderer
  routeSessions: Pick<BrowserRouteSessionRegistry, 'preparePage'>
  routeWebContents: BrowserClientPageLifecycleRegistry
  executeAutomation(
    input: {
      browserPageId: string
      pageHostGeneration: number
      browserProfileId: string
      method: BrowserClientAutomationMethod
      params: Record<string, unknown>
      registration: BrowserClientRetainedPage['registration']
    },
    signal: AbortSignal
  ): Promise<unknown>
  retireAutomation(input: {
    browserPageId: string
    pageHostGeneration: number
    registration: BrowserClientRetainedPage['registration']
  }): Promise<void>
  onPageUnavailable?(browserPageId: string, pageHostGeneration: number): void
  maxPages?: number
}

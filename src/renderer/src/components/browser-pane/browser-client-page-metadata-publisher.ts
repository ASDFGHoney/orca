import type { BrowserClientPageMetadataParams } from '../../../../shared/browser-client-page-metadata-protocol'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'

export type BrowserClientPageMetadataSnapshot = Pick<
  BrowserClientPageMetadataParams,
  'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward'
>

type RuntimeEnvironmentCall = (args: {
  selector: string
  method: string
  params: BrowserClientPageMetadataParams
}) => Promise<unknown>

export function createBrowserClientPageMetadataPublisher(options: {
  environmentId: string
  browserPageId: string
  placement: RuntimeBrowserClientPlacement
  nextRevision: () => number
  call: RuntimeEnvironmentCall
}): {
  publish(snapshot: BrowserClientPageMetadataSnapshot): void
  dispose(): void
} {
  let disposed = false
  let inFlight = false
  let pending: BrowserClientPageMetadataSnapshot | null = null

  const send = (snapshot: BrowserClientPageMetadataSnapshot): void => {
    inFlight = true
    const params: BrowserClientPageMetadataParams = {
      browserHostClientId: options.placement.browserHostClientId,
      browserHostGeneration: options.placement.browserHostGeneration,
      browserPageId: options.browserPageId,
      pageHostGeneration: options.placement.pageHostGeneration,
      revision: options.nextRevision(),
      ...snapshot
    }
    let request: Promise<unknown>
    try {
      request = options.call({
        selector: options.environmentId,
        method: 'browser.clientHost.pageMetadata',
        params
      })
    } catch (error) {
      request = Promise.reject(error)
    }
    void request
      .catch(() => undefined)
      .finally(() => {
        inFlight = false
        if (disposed) {
          pending = null
          return
        }
        const next = pending
        pending = null
        if (next) {
          send(next)
        }
      })
  }

  return {
    publish: (snapshot) => {
      if (disposed) {
        return
      }
      const fullSnapshot = { ...snapshot }
      if (inFlight) {
        pending = fullSnapshot
        return
      }
      send(fullSnapshot)
    },
    dispose: () => {
      disposed = true
      pending = null
    }
  }
}

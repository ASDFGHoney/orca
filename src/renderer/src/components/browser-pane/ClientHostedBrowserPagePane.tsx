import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { BrowserPage as BrowserPageState } from '../../../../shared/browser-workspace-types'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import {
  createBrowserClientPageMetadataPublisher,
  type BrowserClientPageMetadataSnapshot
} from './browser-client-page-metadata-publisher'
import { attachBrowserClientPageToViewport } from './browser-client-page-renderer-installation'
import BrowserAddressBar from './BrowserAddressBar'

export type BrowserTabPageState = Partial<
  Pick<
    BrowserPageState,
    'title' | 'loading' | 'faviconUrl' | 'canGoBack' | 'canGoForward' | 'loadError'
  >
>

export type BrowserPageUrlSetter = (
  tabId: string,
  url: string,
  options?: { preserveLoadError?: boolean }
) => void

export function ClientHostedBrowserPagePane({
  browserTab,
  runtimeEnvironmentId,
  placement,
  isActive,
  onUpdatePageState,
  onSetUrl
}: {
  browserTab: BrowserPageState
  runtimeEnvironmentId: string
  placement: RuntimeBrowserClientPlacement
  isActive: boolean
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: BrowserPageUrlSetter
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const [addressBarValue, setAddressBarValue] = useState(toDisplayUrl(browserTab.url))
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const updatePageStateFromGuest = useEffectEvent(onUpdatePageState)
  const setUrlFromGuest = useEffectEvent(onSetUrl)
  const { browserHostClientId, browserHostGeneration, pageHostGeneration } = placement

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    let attachment: ReturnType<typeof attachBrowserClientPageToViewport>
    try {
      attachment = attachBrowserClientPageToViewport(
        { browserPageId: browserTab.id, pageHostGeneration },
        viewport
      )
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'browser_client_page_unavailable')
      return
    }
    if (!attachment) {
      setAttachmentError('browser_client_page_renderer_unavailable')
      return
    }
    const webview = attachment.webview
    const publisher = createBrowserClientPageMetadataPublisher({
      environmentId: runtimeEnvironmentId,
      browserPageId: browserTab.id,
      placement: {
        kind: 'client',
        browserHostClientId,
        browserHostGeneration,
        pageHostGeneration
      },
      nextRevision: attachment.nextMetadataRevision,
      call: (args) => window.api.runtimeEnvironments.call(args)
    })
    webviewRef.current = webview
    setAttachmentError(null)
    const syncNavigation = (event?: Event): void => {
      const eventUrl = (event as (Event & { url?: string }) | undefined)?.url
      const metadata = readClientPageMetadata(webview, eventUrl)
      setUrlFromGuest(browserTab.id, metadata.url, {
        preserveLoadError: true
      })
      updatePageStateFromGuest(browserTab.id, {
        title: metadata.title,
        loading: metadata.loading,
        canGoBack: metadata.canGoBack,
        canGoForward: metadata.canGoForward,
        loadError: null
      })
      publisher.publish(metadata)
      setAddressBarValue(toDisplayUrl(metadata.url))
    }
    const onStart = (): void => {
      updatePageStateFromGuest(browserTab.id, { loading: true, loadError: null })
      publisher.publish(readClientPageMetadata(webview, undefined, true))
    }
    webview.addEventListener('did-start-loading', onStart)
    webview.addEventListener('did-stop-loading', syncNavigation)
    webview.addEventListener('did-navigate', syncNavigation)
    webview.addEventListener('did-navigate-in-page', syncNavigation)
    webview.addEventListener('page-title-updated', syncNavigation)
    syncNavigation()
    return () => {
      webview.removeEventListener('did-start-loading', onStart)
      webview.removeEventListener('did-stop-loading', syncNavigation)
      webview.removeEventListener('did-navigate', syncNavigation)
      webview.removeEventListener('did-navigate-in-page', syncNavigation)
      webview.removeEventListener('page-title-updated', syncNavigation)
      if (webviewRef.current === webview) {
        webviewRef.current = null
      }
      publisher.dispose()
      attachment.detach()
    }
  }, [
    browserTab.id,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    runtimeEnvironmentId
  ])

  useEffect(() => {
    if (isActive) {
      webviewRef.current?.focus()
    }
  }, [isActive])

  useEffect(() => {
    setAddressBarValue(toDisplayUrl(browserTab.url))
  }, [browserTab.url])

  const navigateToUrl = useCallback(
    (value: string) => {
      const nextUrl = normalizeBrowserNavigationUrl(value)
      const webview = webviewRef.current
      if (!nextUrl || !webview) {
        return
      }
      onUpdatePageState(browserTab.id, { loading: true, loadError: null })
      void webview.loadURL(nextUrl)
    },
    [browserTab.id, onUpdatePageState]
  )

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className="relative z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5">
        <Button
          size="icon"
          variant="ghost"
          disabled={!browserTab.canGoBack}
          aria-label={translate('browser.clientHosted.back', 'Back')}
          onClick={() => webviewRef.current?.goBack()}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          disabled={!browserTab.canGoForward}
          aria-label={translate('browser.clientHosted.forward', 'Forward')}
          onClick={() => webviewRef.current?.goForward()}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={translate('browser.clientHosted.reload', 'Reload')}
          onClick={() => webviewRef.current?.reload()}
        >
          {browserTab.loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </Button>
        <BrowserAddressBar
          value={addressBarValue}
          onChange={setAddressBarValue}
          onSubmit={() => navigateToUrl(addressBarValue)}
          onNavigate={navigateToUrl}
          inputRef={addressBarInputRef}
        />
      </div>
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {attachmentError ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-2">
              <Globe className="size-5 text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">
                {translate(
                  'browser.clientHosted.unavailableTitle',
                  'Client-hosted browser unavailable'
                )}
              </div>
              <div className="text-xs leading-5 text-muted-foreground">
                {translate(
                  'browser.clientHosted.unavailableDescription',
                  'This page is attached to a different desktop or is no longer available.'
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function toDisplayUrl(url: string): string {
  return url === ORCA_BROWSER_BLANK_URL ? 'about:blank' : redactKagiSessionToken(url)
}

function readClientPageMetadata(
  webview: Electron.WebviewTag,
  eventUrl?: string,
  loading?: boolean
): BrowserClientPageMetadataSnapshot {
  const url = redactKagiSessionToken(eventUrl || webview.getURL() || 'about:blank')
  return {
    url,
    title: webview.getTitle() || url || 'Browser',
    loading: loading ?? webview.isLoading(),
    canGoBack: webview.canGoBack(),
    canGoForward: webview.canGoForward()
  }
}

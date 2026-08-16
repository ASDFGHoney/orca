import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { normalizeExternalBrowserUrl } from '../../../../../shared/browser-url'
import type { BrowserPageContextMenuState } from '../describe-page/browser-page-types'

export function BrowserPageContextMenu({
  browserPageId,
  worktreeId,
  canGoBack,
  canGoForward,
  webviewRef,
  onReload
}: {
  browserPageId: string
  worktreeId: string
  canGoBack: boolean
  canGoForward: boolean
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  onReload: () => void
}): React.JSX.Element | null {
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const [contextMenu, setContextMenu] = useState<BrowserPageContextMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return window.api.browser.onContextMenuRequested((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      // Why: convert OS screen cursor coords to renderer CSS pixels — immune to guest/renderer coordinate-space mismatches from zoom/DPI.
      const zoomFactor = 1.2 ** window.api.ui.getZoomLevel()
      const x = Math.round((event.screenX - window.screenX) / zoomFactor)
      const y = Math.round((event.screenY - window.screenY) / zoomFactor)
      console.debug(
        '[context-menu] screen=(%d,%d) window=(%d,%d) zoom=%.2f → viewport=(%d,%d)',
        event.screenX,
        event.screenY,
        window.screenX,
        window.screenY,
        zoomFactor,
        x,
        y
      )
      setContextMenu({
        x,
        y,
        linkUrl: event.linkUrl,
        pageUrl: event.pageUrl,
        selectionText: event.selectionText ?? ''
      })
    })
  }, [browserPageId])

  useEffect(() => {
    return window.api.browser.onContextMenuDismissed((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      setContextMenu(null)
    })
  }, [browserPageId])

  useEffect(() => {
    if (!contextMenu) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setContextMenu(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [contextMenu])

  // Why: ancestor CSS (transform/backdrop-filter) can shift position:fixed even via a body Portal, so measure/correct before paint; also flip on viewport overflow.
  useLayoutEffect(() => {
    const el = contextMenuRef.current
    if (!el || !contextMenu) {
      return
    }
    el.style.left = `${contextMenu.x}px`
    el.style.top = `${contextMenu.y}px`
    const rect = el.getBoundingClientRect()

    // Why: CSS containing blocks can shift "fixed" elements; capture the offset between requested and actual position.
    const offsetX = contextMenu.x - rect.left
    const offsetY = contextMenu.y - rect.top

    let renderX = contextMenu.x
    let renderY = contextMenu.y

    // Flip so the opposite corner aligns with the cursor when the menu overflows.
    if (rect.right > window.innerWidth) {
      renderX = contextMenu.x - rect.width
    }
    if (rect.bottom > window.innerHeight) {
      renderY = contextMenu.y - rect.height
    }

    renderX = Math.max(0, renderX)
    renderY = Math.max(0, renderY)

    el.style.left = `${renderX + offsetX}px`
    el.style.top = `${renderY + offsetY}px`
  }, [contextMenu])

  if (!contextMenu) {
    return null
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-50" onPointerDown={() => setContextMenu(null)} />
      <div
        ref={contextMenuRef}
        role="menu"
        data-testid="browser-context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        className="fixed z-50 min-w-[13rem] overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-1 text-black shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:text-white dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]"
      >
        {contextMenu.linkUrl ? (
          <>
            <button
              role="menuitem"
              className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
              onClick={() => {
                createBrowserTab(worktreeId, contextMenu.linkUrl!, {
                  title: contextMenu.linkUrl!
                })
                setContextMenu(null)
              }}
            >
              {translate(
                'auto.components.browser.pane.BrowserPane.b5b87d6cbb',
                'Open Link In Orca Browser'
              )}
            </button>
            <button
              role="menuitem"
              className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
              onClick={() => {
                const targetUrl = normalizeExternalBrowserUrl(contextMenu.linkUrl!)
                if (targetUrl) {
                  void window.api.shell.openUrl(targetUrl)
                }
                setContextMenu(null)
              }}
            >
              {translate(
                'auto.components.browser.pane.BrowserPane.8ce4f6b12e',
                'Open Link In Default Browser'
              )}
            </button>
            <button
              role="menuitem"
              className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
              onClick={() => {
                void window.api.ui.writeClipboardText(contextMenu.linkUrl ?? '')
                setContextMenu(null)
              }}
            >
              {translate(
                'auto.components.browser.pane.BrowserPane.efb0e8f7f3',
                'Copy Link Address'
              )}
            </button>
            <div className="my-1 h-px bg-border/70" />
          </>
        ) : null}
        {contextMenu.selectionText.trim() ? (
          <>
            <button
              role="menuitem"
              className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
              onClick={() => {
                void window.api.ui.writeClipboardText(contextMenu.selectionText)
                setContextMenu(null)
              }}
            >
              {translate('auto.components.browser.pane.BrowserPane.2a4c4b8e1f', 'Copy')}
            </button>
            <div className="my-1 h-px bg-border/70" />
          </>
        ) : null}
        <button
          role="menuitem"
          disabled={!canGoBack}
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/14"
          onClick={() => {
            webviewRef.current?.goBack()
            setContextMenu(null)
          }}
        >
          {translate('auto.components.browser.pane.BrowserPane.40edfa75cb', 'Back')}
        </button>
        <button
          role="menuitem"
          disabled={!canGoForward}
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/14"
          onClick={() => {
            webviewRef.current?.goForward()
            setContextMenu(null)
          }}
        >
          {translate('auto.components.browser.pane.BrowserPane.250a9b3e42', 'Forward')}
        </button>
        <button
          role="menuitem"
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
          onClick={() => {
            onReload()
            setContextMenu(null)
          }}
        >
          {translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
        </button>
        <div className="my-1 h-px bg-border/70" />
        <button
          role="menuitem"
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
          onClick={() => {
            const targetUrl = normalizeExternalBrowserUrl(contextMenu.pageUrl)
            if (targetUrl) {
              void window.api.shell.openUrl(targetUrl)
            }
            setContextMenu(null)
          }}
        >
          {translate(
            'auto.components.browser.pane.BrowserPane.f7ab83f7ed',
            'Open Page In Default Browser'
          )}
        </button>
        <button
          role="menuitem"
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
          onClick={() => {
            void window.api.ui.writeClipboardText(contextMenu.pageUrl)
            setContextMenu(null)
          }}
        >
          {translate('auto.components.browser.pane.BrowserPane.1b179ab561', 'Copy Page URL')}
        </button>
        <div className="my-1 h-px bg-border/70" />
        <button
          role="menuitem"
          className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
          onClick={() => {
            void window.api.browser.openDevTools({ browserPageId })
            setContextMenu(null)
          }}
        >
          {translate('auto.components.browser.pane.BrowserPane.a8f37f70c3', 'Inspect Page')}
        </button>
      </div>
    </>,
    document.body
  )
}

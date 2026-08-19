import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  openPopupWithOriginBarMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: browserMocks.appGetPathMock },
  BrowserWindow: { fromWebContents: browserMocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: browserMocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock },
  webContents: { fromId: browserMocks.webContentsFromIdMock }
}))

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import type { BrowserClientDownloadRoute } from './browser-client-download-relay'
import { setBrowserClientDownloadRouter } from './browser-client-download-routing'
import {
  registerBrowserRouteGuestPopup,
  resetBrowserRouteGuestPopupOwnership
} from './browser-route-guest-popup-ownership'
import {
  createDownloadItem,
  getDownloadItemEventHandler,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'

const GUEST_WEB_CONTENTS_ID = 6100
const POPUP_WEB_CONTENTS_ID = 6101
const BROWSER_PAGE_ID = 'client-page-1'

describe('client-hosted downloads', () => {
  let rendererSendMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
    resetBrowserRouteGuestPopupOwnership()
    rendererSendMock = vi.fn()
    const guest = {
      id: GUEST_WEB_CONTENTS_ID,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: browserMocks.guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: browserMocks.guestSetWindowOpenHandlerMock,
      on: browserMocks.guestOnMock,
      off: browserMocks.guestOffMock,
      openDevTools: browserMocks.guestOpenDevToolsMock
    }
    browserMocks.webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === GUEST_WEB_CONTENTS_ID) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: BROWSER_PAGE_ID,
      webContentsId: GUEST_WEB_CONTENTS_ID,
      rendererWebContentsId
    })
  })

  afterEach(() => {
    setBrowserClientDownloadRouter(null)
    resetBrowserRouteGuestPopupOwnership()
  })

  it('routes a route-guest popup download through the opener page instead of desktop Downloads', async () => {
    const routed: number[] = []
    const { route, completed } = stubRoute()
    setBrowserClientDownloadRouter({
      route: (input) => {
        routed.push(input.guestWebContentsId)
        return input.guestWebContentsId === GUEST_WEB_CONTENTS_ID ? route : null
      }
    })
    registerBrowserRouteGuestPopup({
      popupWebContentsId: POPUP_WEB_CONTENTS_ID,
      openerWebContentsId: GUEST_WEB_CONTENTS_ID
    })
    const item = createDownloadItem()

    browserManager.handleGuestWillDownload({
      guestWebContentsId: POPUP_WEB_CONTENTS_ID,
      item
    })

    // The popup has no logical page of its own, so ownership resolves to the opener's page.
    expect(routed).toEqual([GUEST_WEB_CONTENTS_ID])
    expect(item.setSavePath).toHaveBeenCalledWith('/tmp/staging/transfer-1/download')
    expect(browserMocks.appGetPathMock).not.toHaveBeenCalledWith('downloads')

    getDownloadItemEventHandler(item, 'once', 'done')?.({} as Electron.Event, 'completed')
    await completed

    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({
        browserPageId: BROWSER_PAGE_ID,
        status: 'completed',
        savePath: null,
        remoteDestination: {
          workspaceRelativePath: '.orca/browser-downloads/report.csv',
          hostLabel: 'build-box'
        }
      })
    )
  })

  it('routes an unowned popup nowhere near the opener page', () => {
    const routed: number[] = []
    setBrowserClientDownloadRouter({
      route: (input) => {
        routed.push(input.guestWebContentsId)
        return null
      }
    })

    browserManager.handleGuestWillDownload({
      guestWebContentsId: POPUP_WEB_CONTENTS_ID,
      item: createDownloadItem()
    })

    expect(routed).toEqual([POPUP_WEB_CONTENTS_ID])
  })
})

function stubRoute(): { route: BrowserClientDownloadRoute; completed: Promise<void> } {
  let resolveCompleted = (): void => {}
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })
  const route: BrowserClientDownloadRoute = {
    transferId: 'transfer-1',
    browserPageId: BROWSER_PAGE_ID,
    stagingPath: '/tmp/staging/transfer-1/download',
    complete: async () => {
      resolveCompleted()
      return {
        workspaceRelativePath: '.orca/browser-downloads/report.csv',
        hostLabel: 'build-box'
      }
    },
    abort: async () => {}
  }
  return { route, completed }
}

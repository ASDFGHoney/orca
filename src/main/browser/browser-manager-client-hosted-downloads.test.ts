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
import type {
  BrowserClientDownloadRoute,
  BrowserClientDownloadRouteOutcome
} from './browser-client-download-relay'
import {
  registerBrowserClientDownloadRouter,
  resetBrowserClientDownloadRouting,
  setBrowserClientRouteWebContentsProbe
} from './browser-client-download-routing'
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
const ORPHAN_POPUP_WEB_CONTENTS_ID = 6102
const SERVER_GUEST_WEB_CONTENTS_ID = 6103
const BROWSER_PAGE_ID = 'client-page-1'

describe('client-hosted downloads', () => {
  let rendererSendMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
    resetBrowserClientDownloadRouting()
    resetBrowserRouteGuestPopupOwnership()
    rendererSendMock = vi.fn()
    const guest = createGuest(GUEST_WEB_CONTENTS_ID)
    const serverGuest = createGuest(SERVER_GUEST_WEB_CONTENTS_ID)
    browserMocks.webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === GUEST_WEB_CONTENTS_ID) {
        return guest
      }
      if (id === SERVER_GUEST_WEB_CONTENTS_ID) {
        return serverGuest
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
    browserManager.attachGuestPolicies(serverGuest as never)
    browserManager.registerGuest({
      browserPageId: 'server-page-1',
      webContentsId: SERVER_GUEST_WEB_CONTENTS_ID,
      rendererWebContentsId
    })
    // Every client-hosted WebContents in this suite is a route guest or one of its popups.
    setBrowserClientRouteWebContentsProbe((id) => id !== SERVER_GUEST_WEB_CONTENTS_ID)
  })

  afterEach(() => {
    resetBrowserClientDownloadRouting()
    resetBrowserRouteGuestPopupOwnership()
  })

  it('routes a route-guest popup download through the opener page instead of desktop Downloads', async () => {
    const routed: number[] = []
    const { route, completed } = stubRoute()
    registerBrowserClientDownloadRouter('env-a', {
      route: (input) => {
        routed.push(input.guestWebContentsId)
        return input.guestWebContentsId === GUEST_WEB_CONTENTS_ID
          ? { kind: 'remote', route }
          : { kind: 'unowned' }
      }
    })
    registerBrowserRouteGuestPopup({
      popupWebContentsId: POPUP_WEB_CONTENTS_ID,
      openerWebContentsId: GUEST_WEB_CONTENTS_ID
    })
    const item = createDownloadItem()

    browserManager.handleGuestWillDownload({ guestWebContentsId: POPUP_WEB_CONTENTS_ID, item })

    // The popup has no logical page of its own, so ownership resolves to the opener's page.
    expect(routed).toEqual([GUEST_WEB_CONTENTS_ID])
    expect(item.setSavePath).toHaveBeenCalledWith('/tmp/staging/transfer-1/download')
    expect(item.cancel).not.toHaveBeenCalled()

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

  it('cancels a client-hosted download that no composition owns', () => {
    registerBrowserClientDownloadRouter('env-a', { route: () => ({ kind: 'unowned' }) })
    const item = createDownloadItem()

    browserManager.handleGuestWillDownload({
      guestWebContentsId: ORPHAN_POPUP_WEB_CONTENTS_ID,
      item
    })

    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(item.cancel).toHaveBeenCalled()
  })

  it('surfaces the remote failure when the owning page has no usable file channel', () => {
    registerBrowserClientDownloadRouter('env-a', { route: () => ({ kind: 'unavailable' }) })
    const item = createDownloadItem()

    browserManager.handleGuestWillDownload({ guestWebContentsId: GUEST_WEB_CONTENTS_ID, item })

    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(item.cancel).toHaveBeenCalled()
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({
        browserPageId: BROWSER_PAGE_ID,
        status: 'failed',
        savePath: null,
        error: 'Could not save the download to the remote workspace.'
      })
    )
  })

  it('keeps the desktop Downloads fallback for a host that never offered the file channel', () => {
    registerBrowserClientDownloadRouter('env-a', { route: () => ({ kind: 'local-fallback' }) })
    const item = createDownloadItem()

    browserManager.handleGuestWillDownload({ guestWebContentsId: GUEST_WEB_CONTENTS_ID, item })

    expect(item.cancel).not.toHaveBeenCalled()
    expect(savedTo(item)).toContain('/downloads/')
  })

  it('leaves ordinary browser guests on their desktop Downloads path', () => {
    const routed: number[] = []
    registerBrowserClientDownloadRouter('env-a', {
      route: (input): BrowserClientDownloadRouteOutcome => {
        routed.push(input.guestWebContentsId)
        return { kind: 'unowned' }
      }
    })
    const item = createDownloadItem()

    browserManager.handleGuestWillDownload({
      guestWebContentsId: SERVER_GUEST_WEB_CONTENTS_ID,
      item
    })

    expect(routed).toEqual([SERVER_GUEST_WEB_CONTENTS_ID])
    expect(item.cancel).not.toHaveBeenCalled()
    expect(savedTo(item)).toContain('/downloads/')
  })
})

function createGuest(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    setBackgroundThrottling: browserMocks.guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: browserMocks.guestSetWindowOpenHandlerMock,
    on: browserMocks.guestOnMock,
    off: browserMocks.guestOffMock,
    openDevTools: browserMocks.guestOpenDevToolsMock
  }
}

function savedTo(item: Electron.DownloadItem): string {
  const setSavePath = item.setSavePath as unknown as { mock: { calls: [string][] } }
  return setSavePath.mock.calls.at(0)?.[0] ?? ''
}

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

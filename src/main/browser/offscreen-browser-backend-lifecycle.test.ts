import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  windows: [] as { webContents: MockWebContents; isDestroyed(): boolean; destroy(): void }[],
  BrowserWindow: vi.fn(),
  finishLoads: true
}))

class MockWebContents extends EventEmitter {
  readonly id: number

  constructor(id: number) {
    super()
    this.id = id
  }

  loadURL(): Promise<void> {
    if (electronMocks.finishLoads) {
      queueMicrotask(() => this.emit('did-finish-load'))
    }
    return Promise.resolve()
  }
}

class MockBrowserWindow {
  readonly webContents: MockWebContents
  private destroyed = false

  constructor() {
    this.webContents = new MockWebContents(electronMocks.windows.length + 1)
    electronMocks.windows.push(this)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.webContents.emit('destroyed')
  }
}

vi.mock('electron', () => ({ BrowserWindow: electronMocks.BrowserWindow }))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: vi.fn(() => null),
    getDefaultProfile: vi.fn(() => ({
      id: 'default',
      partition: 'persist:orca-browser',
      userAgentMode: 'native'
    }))
  }
}))

import { OffscreenBrowserBackend } from './offscreen-browser-backend'

describe('OffscreenBrowserBackend lifecycle', () => {
  beforeEach(() => {
    electronMocks.windows.length = 0
    electronMocks.finishLoads = true
    electronMocks.BrowserWindow.mockImplementation(function BrowserWindowMock() {
      return new MockBrowserWindow()
    })
  })

  it('reports close once and does not retain closed page ids', async () => {
    const browserManager = {
      registerOffscreenGuest: vi.fn(),
      unregisterGuest: vi.fn()
    }
    const onWebContentsClosed = vi.fn(async () => {})
    const backend = new OffscreenBrowserBackend(browserManager as never, onWebContentsClosed)

    for (let index = 0; index < 50; index += 1) {
      const browserPageId = `page-${index}`
      await backend.createTab({ browserPageId, url: 'about:blank', worktreeId: 'wt-1' })
      await backend.closeTab(browserPageId)
      await backend.closeTab(browserPageId)
    }

    expect(browserManager.unregisterGuest).toHaveBeenCalledTimes(50)
    expect(onWebContentsClosed).toHaveBeenCalledTimes(50)
    expect((backend as unknown as { pagesById: Map<string, unknown> }).pagesById.size).toBe(0)
  })

  it('keeps browser ownership registered until session cleanup resolves', async () => {
    const order: string[] = []
    const browserManager = {
      registerOffscreenGuest: vi.fn(),
      unregisterGuest: vi.fn(() => order.push('unregister'))
    }
    const backend = new OffscreenBrowserBackend(
      browserManager as never,
      vi.fn(async () => {
        order.push('session-cleanup')
      })
    )
    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt-1' })

    await backend.closeTab('page-1')

    expect(order).toEqual(['session-cleanup', 'unregister'])
  })

  it('contains asynchronous cleanup failures during bulk destruction', async () => {
    const cleanupError = new Error('cleanup failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const backend = new OffscreenBrowserBackend(
      {
        registerOffscreenGuest: vi.fn(),
        unregisterGuest: vi.fn()
      } as never,
      vi.fn(async () => {
        throw cleanupError
      })
    )
    await backend.createTab({ browserPageId: 'page-1', url: 'about:blank', worktreeId: 'wt-1' })

    backend.destroyAll()
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[offscreen-browser] tab cleanup failed:',
        cleanupError.message
      )
    )
    expect((backend as unknown as { pagesById: Map<string, unknown> }).pagesById.size).toBe(0)
    warn.mockRestore()
  })

  it('settles a pending load and removes its waiters when the page is destroyed', async () => {
    vi.useFakeTimers()
    electronMocks.finishLoads = false
    const backend = new OffscreenBrowserBackend({
      registerOffscreenGuest: vi.fn(),
      unregisterGuest: vi.fn()
    } as never)

    await backend.createTab({
      browserPageId: 'page-1',
      url: 'https://example.com',
      worktreeId: 'wt'
    })
    const webContents = electronMocks.windows[0].webContents
    expect(webContents.listenerCount('did-finish-load')).toBe(1)
    expect(webContents.listenerCount('did-fail-load')).toBe(1)

    await backend.closeTab('page-1')
    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { ipcMain } from 'electron'
import {
  createMainWindow,
  WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS,
  WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS
} from './createMainWindow'
import {
  browserWindowMock,
  resetMainWindowMocks,
  showMessageBoxMock
} from './createMainWindow-test-harness'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'

const RENDERER_WEB_CONTENTS_ID = 42

type Handlers = Record<string, (...args: any[]) => void>

function setupWindow(): {
  windowHandlers: Handlers
  ipcHandlers: Handlers
  webContents: { send: ReturnType<typeof vi.fn> }
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
} {
  const windowHandlers: Handlers = {}
  const ipcHandlers: Handlers = {}
  vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
    ipcHandlers[channel as string] = handler as (...args: any[]) => void
    return ipcMain
  })
  const webContents = {
    id: RENDERER_WEB_CONTENTS_ID,
    on: vi.fn((event, handler) => {
      windowHandlers[event] = handler
    }),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isCrashed: vi.fn(() => false)
  }
  const destroy = vi.fn()
  const isDestroyed = vi.fn(() => false)
  browserWindowMock.mockImplementation(function () {
    return {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed,
      isVisible: vi.fn(() => true),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      destroy,
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
  })
  return { windowHandlers, ipcHandlers, webContents, destroy, isDestroyed }
}

/** Reads the requestId off the Nth window:close-requested send (0-based). */
function closeRequestIdAt(webContents: { send: ReturnType<typeof vi.fn> }, index: number): number {
  const requests = webContents.send.mock.calls.filter(
    ([channel]) => channel === 'window:close-requested'
  )
  return (requests[index][1] as { requestId: number }).requestId
}

describe('unresponsive ordinary window close', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useFakeTimers()
  })

  // The defect: an ordinary close was preventDefault()ed and then waited forever,
  // leaving Task Manager as the only exit on a wedged renderer.
  it('prompts the user once the renderer misses the ordinary-close deadline', async () => {
    const { windowHandlers, destroy } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS - 1)
    expect(showMessageBoxMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(showMessageBoxMock).toHaveBeenCalledOnce()
    // Why (#5787): the deadline only asks — it never destroys sessions on its own.
    expect(destroy).not.toHaveBeenCalled()
  })

  it('destroys the window when the user picks Close Window', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    const { windowHandlers, destroy } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)

    expect(destroy).toHaveBeenCalledOnce()
  })

  // Why: the renderer-drawn X is dead while the renderer is wedged, so a one-shot
  // prompt the user dismisses would strand them with no way to ask again.
  it('re-arms the deadline when the user picks Wait', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    const { windowHandlers, destroy } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)
    expect(showMessageBoxMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)

    expect(showMessageBoxMock).toHaveBeenCalledTimes(2)
    expect(destroy).not.toHaveBeenCalled()
  })

  it('leaves a healthy close untouched — no dialog, no destroy, no added latency', async () => {
    const { windowHandlers, ipcHandlers, webContents, destroy } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    const preventDefault = vi.fn()
    windowHandlers.close({ preventDefault } as never)
    // The request goes out synchronously; the renderer acks receipt in its IPC listener.
    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: false,
      requestId: expect.any(Number)
    })
    ipcHandlers['window:close-request-received']?.(
      { sender: { id: RENDERER_WEB_CONTENTS_ID } },
      closeRequestIdAt(webContents, 0)
    )
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS * 3)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
  })

  // The renderer-drawn X used to send no requestId at all, so its ack could never
  // be matched and no deadline was ever armed on that path.
  it('bounds the renderer-drawn X, which now carries a requestId', async () => {
    const { ipcHandlers, webContents } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    ipcHandlers['window:request-close']?.()

    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: false,
      requestId: expect.any(Number)
    })
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)
    expect(showMessageBoxMock).toHaveBeenCalledOnce()
  })

  it('clears the renderer-drawn X deadline when the renderer acknowledges', async () => {
    const { ipcHandlers, webContents } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    ipcHandlers['window:request-close']?.()
    ipcHandlers['window:close-request-received']?.(
      { sender: { id: RENDERER_WEB_CONTENTS_ID } },
      closeRequestIdAt(webContents, 0)
    )
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)

    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  // A renderer that unwedges after the deadline must not double-close or throw.
  it('survives a late acknowledgement that arrives after the deadline fired', async () => {
    // Why: initialized rather than null so TS keeps it callable after the executor assigns it.
    let resolveDialog: (value: { response: number }) => void = () => {}
    showMessageBoxMock.mockImplementation(
      () =>
        new Promise<{ response: number }>((resolve) => {
          resolveDialog = resolve
        })
    )
    const { windowHandlers, ipcHandlers, webContents, destroy } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)
    expect(showMessageBoxMock).toHaveBeenCalledOnce()

    // Late ack for the already-expired request: matches nothing, changes nothing.
    expect(() =>
      ipcHandlers['window:close-request-received']?.(
        { sender: { id: RENDERER_WEB_CONTENTS_ID } },
        closeRequestIdAt(webContents, 0)
      )
    ).not.toThrow()
    resolveDialog({ response: 1 })
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)

    expect(showMessageBoxMock).toHaveBeenCalledOnce()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('does not stack prompts across rapid repeated close attempts', async () => {
    // Why: initialized rather than null so TS keeps it callable after the executor assigns it.
    let resolveDialog: (value: { response: number }) => void = () => {}
    showMessageBoxMock.mockImplementation(
      () =>
        new Promise<{ response: number }>((resolve) => {
          resolveDialog = resolve
        })
    )
    const { windowHandlers } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    windowHandlers.close({ preventDefault: vi.fn() } as never)
    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS * 3)

    expect(showMessageBoxMock).toHaveBeenCalledOnce()
    resolveDialog({ response: 0 })
  })

  // Why: will-quit stays blocked once a quit is in flight, so the deadline must
  // still destroy rather than downgrade to a dialog nobody can get past.
  it('escalates a pending ordinary deadline to the quit destroy when a quit arrives', async () => {
    let isQuitting = false
    const { windowHandlers, destroy } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => isQuitting })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    isQuitting = true
    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS)

    expect(destroy).toHaveBeenCalledOnce()
    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  it('does not prompt after the window is already destroyed', async () => {
    const { windowHandlers, isDestroyed } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    isDestroyed.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)

    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })
})

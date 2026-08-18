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
  WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS,
  WINDOW_UNRESPONSIVE_CLOSE_MAX_PROBE_INTERVAL_MS
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

/** Why: the Wait branch resumes in a microtask after showMessageBox settles; advancing timers alone can run the next deadline before that continuation. */
async function flushDialogDecision(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** All window:close-requested payloads sent so far, oldest first. */
function closeRequests(webContents: {
  send: ReturnType<typeof vi.fn>
}): { isQuitting: boolean; requestId: number }[] {
  return webContents.send.mock.calls
    .filter(([channel]) => channel === 'window:close-requested')
    .map(([, payload]) => payload as { isQuitting: boolean; requestId: number })
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
  it('re-probes with a NEW request after Wait, so a recovered renderer can answer', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    const { windowHandlers, webContents, destroy } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)
    expect(showMessageBoxMock).toHaveBeenCalledOnce()

    // The defect this pins: re-ARMING the consumed requestId left a deadline that
    // preload could never ack, because main never sent that id again.
    const requests = closeRequests(webContents)
    expect(requests).toHaveLength(2)
    expect(requests[1].requestId).toBeGreaterThan(requests[0].requestId)
    expect(requests[1].isQuitting).toBe(false)
    expect(destroy).not.toHaveBeenCalled()
  })

  it('stops probing once the renderer acknowledges the re-sent request', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    const { windowHandlers, ipcHandlers, webContents } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)
    ipcHandlers['window:close-request-received']?.(
      { sender: { id: RENDERER_WEB_CONTENTS_ID } },
      closeRequestIdAt(webContents, 1)
    )
    await vi.advanceTimersByTimeAsync(WINDOW_UNRESPONSIVE_CLOSE_MAX_PROBE_INTERVAL_MS * 5)

    expect(showMessageBoxMock).toHaveBeenCalledOnce()
    expect(closeRequests(webContents)).toHaveLength(2)
  })

  // The loop this pins: the deadline nulls the armed id, so an ack that lands while
  // the dialog is up used to be discarded and a healthy renderer was re-accused every 10s.
  it('does not re-prompt when the renderer acknowledges while the prompt is open', async () => {
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

    // Renderer unwedges mid-dialog and acks the request it finally drained.
    ipcHandlers['window:close-request-received']?.(
      { sender: { id: RENDERER_WEB_CONTENTS_ID } },
      closeRequestIdAt(webContents, 0)
    )
    resolveDialog({ response: 0 })
    await flushDialogDecision()
    await vi.advanceTimersByTimeAsync(WINDOW_UNRESPONSIVE_CLOSE_MAX_PROBE_INTERVAL_MS * 5)

    expect(showMessageBoxMock).toHaveBeenCalledOnce()
    expect(closeRequests(webContents)).toHaveLength(1)
    expect(destroy).not.toHaveBeenCalled()
  })

  // Why: a fixed 10s beat turns Wait into a nag with a destructive button at a fixed
  // screen position; a renderer busy for minutes deserves a widening interval.
  it('backs the re-probe off and caps it', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    const { windowHandlers } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)
    expect(showMessageBoxMock).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS * 2 - 1)
    expect(showMessageBoxMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(showMessageBoxMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS * 4)
    expect(showMessageBoxMock).toHaveBeenCalledTimes(3)

    // Capped: no interval ever exceeds the ceiling.
    await vi.advanceTimersByTimeAsync(WINDOW_UNRESPONSIVE_CLOSE_MAX_PROBE_INTERVAL_MS)
    expect(showMessageBoxMock).toHaveBeenCalledTimes(4)
  })

  // Why: a dialog that throws must not silently restore the unbounded wait.
  it('treats a failed dialog as Wait and keeps the close bounded', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    showMessageBoxMock.mockRejectedValue(new Error('no display'))
    const { windowHandlers, webContents, destroy } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS)

    expect(consoleError).toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
    expect(closeRequests(webContents)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS * 2)
    expect(showMessageBoxMock).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
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
    await flushDialogDecision()
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

  // Why: a quit that inherits an almost-expired ordinary deadline would destroy the
  // window milliseconds after Cmd+Q, where main has always granted a full 10s.
  it('gives a quit its own full grace even when an ordinary deadline is nearly up', async () => {
    let isQuitting = false
    const { windowHandlers, destroy } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => isQuitting })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS - 100)
    isQuitting = true
    windowHandlers.close({ preventDefault: vi.fn() } as never)

    await vi.advanceTimersByTimeAsync(WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS - 1)
    expect(destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(destroy).toHaveBeenCalledOnce()
    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  // Why: only the quit escalation re-arms — repeated Alt+F4 on a wedged renderer must
  // not push the bound out forever.
  it('does not defer the deadline when ordinary closes repeat', async () => {
    const { windowHandlers } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_RENDERER_ACK_TIMEOUT_MS - 1)
    windowHandlers.close({ preventDefault: vi.fn() } as never)
    await vi.advanceTimersByTimeAsync(1)

    expect(showMessageBoxMock).toHaveBeenCalledOnce()
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

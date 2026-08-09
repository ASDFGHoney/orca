import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcEmitter = new EventEmitter()
const ipcMainMock = {
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.on(channel, listener)
  }),
  removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.removeListener(channel, listener)
  })
}

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))

describe('requestSessionTabCloseFromRenderer', () => {
  beforeEach(() => {
    ipcEmitter.removeAllListeners()
    ipcMainMock.on.mockClear()
    ipcMainMock.removeListener.mockClear()
  })

  it('waits for the targeted renderer acknowledgement', async () => {
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const pending = requestSessionTabCloseFromRenderer(
      { isDestroyed: () => false, webContents } as never,
      'tab-1',
      'wt-1'
    )
    const request = webContents.send.mock.calls[0]?.[1] as {
      requestId: string
      tabId: string
      worktreeId: string
    }

    expect(request).toMatchObject({ tabId: 'tab-1', worktreeId: 'wt-1' })
    ipcEmitter.emit('ui:sessionTabCloseResponse', { sender: {} }, { requestId: request.requestId })
    let settled = false
    void pending.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    ipcEmitter.emit(
      'ui:sessionTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId }
    )
    await expect(pending).resolves.toBeUndefined()
  })

  it('propagates renderer cancellation', async () => {
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const pending = requestSessionTabCloseFromRenderer(
      { isDestroyed: () => false, webContents } as never,
      'tab-pinned',
      'wt-1'
    )
    const request = webContents.send.mock.calls[0]?.[1] as { requestId: string }

    ipcEmitter.emit(
      'ui:sessionTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId, error: 'session_tab_close_canceled' }
    )

    await expect(pending).rejects.toThrow('session_tab_close_canceled')
  })
})

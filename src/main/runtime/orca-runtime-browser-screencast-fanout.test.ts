import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES } from '../../shared/remote-runtime-memory-limits'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../browser/browser-screencast-stream', () => ({ startBrowserScreencast }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createCommandsHost(): RuntimeBrowserCommandHost {
  const bridge = {
    getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
    getActivePageId: vi.fn(() => 'page-1'),
    tabList: vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'page-1',
          index: 0,
          url: 'about:blank',
          title: 'Browser',
          active: true
        }
      ]
    }))
  } as unknown as AgentBrowserBridge
  return {
    resolveWorktreeSelector: async () => ({ id: 'wt-1' }),
    getAgentBrowserBridge: () => bridge,
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null)
  } as unknown as RuntimeBrowserCommandHost
}

describe('RuntimeBrowserCommands screencast fanout', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue({ isDestroyed: () => false })
    startBrowserScreencast.mockReset()
  })

  it('rejects incompatible subscriber geometry without disturbing the live stream', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    const updateViewport = vi.fn(async () => {})
    startBrowserScreencast.mockResolvedValue({ stop, done: done.promise, updateViewport })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const firstSend = vi.fn(() => false)
    const secondSend = vi.fn(() => true)
    const first = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 1200,
        viewportHeight: 800
      },
      { sendBinary: firstSend }
    )
    await expect(
      commands.browserScreencast(
        {
          worktree: 'id:wt-1',
          page: 'page-1',
          format: 'jpeg',
          viewportWidth: 800,
          viewportHeight: 600
        },
        { sendBinary: secondSend }
      )
    ).rejects.toThrow('already streaming at a different viewport')

    const frame = new Uint8Array([1, 2, 3])
    expect(startBrowserScreencast).toHaveBeenCalledOnce()
    expect(startBrowserScreencast.mock.calls[0][1].onFrame(frame)).toBe(true)
    expect(firstSend).toHaveBeenCalledWith(frame)
    expect(secondSend).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(updateViewport).not.toHaveBeenCalled()
    first.session.stop()
    await first.session.done
    expect(stop).toHaveBeenCalledOnce()
  })

  it('fans out one stream to clients with matching geometry', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    startBrowserScreencast.mockResolvedValue({
      stop,
      done: done.promise,
      updateViewport: vi.fn(async () => {})
    })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const firstSend = vi.fn(() => true)
    const secondSend = vi.fn(() => true)
    const params = {
      worktree: 'id:wt-1',
      page: 'page-1',
      format: 'jpeg' as const,
      viewportWidth: 1200,
      viewportHeight: 800
    }

    const first = await commands.browserScreencast(params, { sendBinary: firstSend })
    const second = await commands.browserScreencast(params, { sendBinary: secondSend })
    const frame = new Uint8Array([1, 2, 3])
    startBrowserScreencast.mock.calls[0][1].onFrame(frame)

    expect(startBrowserScreencast).toHaveBeenCalledOnce()
    expect(firstSend).toHaveBeenCalledWith(frame)
    expect(secondSend).toHaveBeenCalledWith(frame)
    second.session.stop()
    await second.session.done
    expect(stop).not.toHaveBeenCalled()
    first.session.stop()
    await first.session.done
    expect(stop).toHaveBeenCalledOnce()
  })

  it('admits shared frames through the paired-runtime size guard', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    startBrowserScreencast.mockResolvedValue({
      stop: vi.fn(() => done.resolve()),
      done: done.promise,
      updateViewport: vi.fn(async () => {})
    })
    const sendBinary = vi.fn(() => true)
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const started = await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary }
    )
    const { onFrame } = startBrowserScreencast.mock.calls[0][1]

    expect(onFrame(new Uint8Array(REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + 1))).toBe(true)
    expect(sendBinary).not.toHaveBeenCalled()
    expect(onFrame(new Uint8Array(64))).toBe(true)
    expect(sendBinary).toHaveBeenCalledOnce()
    started.session.stop()
    await started.session.done
  })
})

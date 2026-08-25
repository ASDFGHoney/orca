import { describe, expect, it, vi } from 'vitest'
import { isRendererGone, rendererWebContents, sendToRenderer } from './pty-renderer-surface'

/**
 * Regression cover for STA-5373: #15927 replaced a two-condition renderer-liveness
 * guard with a one-condition one, dropping the `webContents.isDestroyed()` half.
 *
 * That is fatal rather than cosmetic. `webContents.send()` throws on a destroyed
 * webContents, the daemon-death fan-out calling it is not inside a try/catch, and an
 * uncaught throw in the Electron main process exits the app — killing every terminal.
 * A live window with dead webContents is the exact state a renderer crash or an
 * in-flight reload produces.
 */
function fakeWindow(options: {
  windowDestroyed?: boolean
  contentsDestroyed?: boolean
  omitIsDestroyed?: boolean
  send?: () => void
}): never {
  const contents = {
    send: options.send ?? (() => {}),
    ...(options.omitIsDestroyed ? {} : { isDestroyed: () => options.contentsDestroyed === true })
  }
  return {
    isDestroyed: () => options.windowDestroyed === true,
    webContents: contents
  } as never
}

describe('pty renderer surface', () => {
  it('treats a live window with destroyed webContents as gone', () => {
    expect(isRendererGone(fakeWindow({ contentsDestroyed: true }))).toBe(true)
  })

  it('does not send to a live window whose webContents is destroyed', () => {
    const send = vi.fn()
    sendToRenderer(fakeWindow({ contentsDestroyed: true, send }), 'pty:data', { id: 'x' })
    expect(send).not.toHaveBeenCalled()
  })

  it('still sends when both the window and its webContents are alive', () => {
    const send = vi.fn()
    sendToRenderer(fakeWindow({ send }), 'pty:data', { id: 'x' })
    expect(send).toHaveBeenCalledExactlyOnceWith('pty:data', { id: 'x' })
  })

  it('treats a destroyed window as gone without consulting webContents', () => {
    expect(isRendererGone(fakeWindow({ windowDestroyed: true }))).toBe(true)
  })

  it('treats a missing renderer as gone', () => {
    expect(isRendererGone(null)).toBe(true)
    expect(rendererWebContents(null)).toBeNull()
  })

  it('survives a webContents that does not expose isDestroyed', () => {
    // Why: the original fix carried a typeof guard, so a partially torn down or stubbed
    // webContents cannot make the liveness check itself throw.
    expect(() => isRendererGone(fakeWindow({ omitIsDestroyed: true }))).not.toThrow()
  })

  it('withholds webContents from callers once it is destroyed', () => {
    expect(rendererWebContents(fakeWindow({ contentsDestroyed: true }))).toBeNull()
  })
})

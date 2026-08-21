import { describe, expect, it, vi } from 'vitest'
import {
  openWindowsInteractiveStdio,
  stdioForWindowsInteractiveChild,
  WINDOWS_CONSOLE_INPUT_DEVICE,
  WINDOWS_CONSOLE_OUTPUT_DEVICE
} from './windows-console-stdio'

describe('openWindowsInteractiveStdio', () => {
  it('returns inherit off Windows without opening devices', () => {
    const openSync = vi.fn()
    expect(openWindowsInteractiveStdio({ platform: 'darwin', openSync })).toBe('inherit')
    expect(openWindowsInteractiveStdio({ platform: 'linux', openSync })).toBe('inherit')
    expect(openSync).not.toHaveBeenCalled()
  })

  it('opens CONIN$ and CONOUT$ on win32 and disposes unique fds once', () => {
    const openSync = vi.fn((path: string) => (path === WINDOWS_CONSOLE_INPUT_DEVICE ? 11 : 12))
    const closeSync = vi.fn()
    const opened = openWindowsInteractiveStdio({ platform: 'win32', openSync, closeSync })
    expect(opened).not.toBe('inherit')
    if (opened === 'inherit') {
      return
    }
    expect(openSync).toHaveBeenCalledWith(WINDOWS_CONSOLE_INPUT_DEVICE, 'r+')
    expect(openSync).toHaveBeenCalledWith(WINDOWS_CONSOLE_OUTPUT_DEVICE, 'w')
    expect(opened.stdio).toEqual([11, 12, 12])
    opened.dispose()
    opened.dispose()
    expect(closeSync).toHaveBeenCalledTimes(2)
    expect(closeSync).toHaveBeenCalledWith(11)
    expect(closeSync).toHaveBeenCalledWith(12)
  })

  it('returns inherit and closes a partial CONIN$ open when CONOUT$ fails', () => {
    const openSync = vi.fn((path: string) => {
      if (path === WINDOWS_CONSOLE_INPUT_DEVICE) {
        return 11
      }
      throw new Error('no console')
    })
    const closeSync = vi.fn()
    expect(openWindowsInteractiveStdio({ platform: 'win32', openSync, closeSync })).toBe('inherit')
    expect(closeSync).toHaveBeenCalledWith(11)
  })

  it('returns inherit when neither device can be opened', () => {
    const openSync = vi.fn(() => {
      throw new Error('no console')
    })
    const closeSync = vi.fn()
    expect(openWindowsInteractiveStdio({ platform: 'win32', openSync, closeSync })).toBe('inherit')
    expect(closeSync).not.toHaveBeenCalled()
  })
})

describe('stdioForWindowsInteractiveChild', () => {
  it('keeps JSON stdout on the CLI envelope stream', () => {
    const openSync = vi.fn((path: string) => (path === WINDOWS_CONSOLE_INPUT_DEVICE ? 11 : 12))
    const { stdio, dispose } = stdioForWindowsInteractiveChild(true, {
      platform: 'win32',
      openSync,
      closeSync: vi.fn()
    })
    expect(stdio).toEqual([11, process.stderr, 12])
    dispose()
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  type PendingCommand = {
    promise: Promise<unknown>
    resolve: (value: unknown) => void
  }

  const events: string[] = []
  const windows: BrowserWindow[] = []
  let firstCommandStarted: () => void = () => undefined
  let firstCommand: PendingCommand
  let userDataPath = ''

  function reset(): void {
    events.length = 0
    windows.length = 0
    let resolveCommand!: (value: unknown) => void
    firstCommand = {
      promise: new Promise((resolve) => {
        resolveCommand = resolve
      }),
      resolve: resolveCommand
    }
  }

  class BrowserWindow {
    readonly label = windows.length === 0 ? 'A' : 'B'
    readonly webContents = {
      label: this.label,
      debugger: {
        sendCommand: vi.fn((method: string): Promise<unknown> => {
          events.push(`${this.label}:${method}`)
          if (this.label === 'A') {
            firstCommandStarted()
            return firstCommand.promise
          }
          return Promise.resolve({ success: true })
        })
      },
      isDestroyed: vi.fn(() => false)
    }

    constructor() {
      windows.push(this)
    }

    async loadURL(): Promise<void> {}

    destroy(): void {
      events.push(`${this.label}:destroy`)
    }
  }

  const cookies = {
    get: vi.fn(async () => []),
    remove: vi.fn(async (_url: string, name: string) => {
      events.push(`rollback:${name}`)
    })
  }
  const stableSession = { cookies }

  reset()
  return {
    BrowserWindow,
    cookies,
    events,
    firstCommand: () => firstCommand,
    onFirstCommand: () =>
      new Promise<void>((resolve) => {
        firstCommandStarted = resolve
      }),
    reset,
    stableSession,
    windows,
    getUserDataPath: () => userDataPath,
    setUserDataPath: (value: string) => {
      userDataPath = value
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: electron.getUserDataPath },
  BrowserWindow: electron.BrowserWindow,
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: vi.fn(() => electron.stableSession) },
  webContents: { getAllWebContents: vi.fn(() => []) }
}))

vi.mock('./electron-debugger-lease', () => ({
  acquireElectronDebugger: (contents: { label: string }) => ({
    release: () => {
      electron.events.push(`${contents.label}:detach`)
    }
  })
}))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: vi.fn(),
    clearPendingCookieImport: vi.fn()
  }
}))

import { importCookiesFromFile } from './browser-cookie-import'

describe('cookie import debugger timeout', () => {
  let fixtureDir: string

  beforeEach(() => {
    vi.useFakeTimers()
    electron.reset()
    electron.cookies.get.mockClear()
    electron.cookies.remove.mockClear()
    fixtureDir = mkdtempSync(join(tmpdir(), 'orca-cookie-cdp-timeout-'))
    electron.setUserDataPath(fixtureDir)
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  function writeCookieSource(name: string): string {
    const filePath = join(fixtureDir, `${name}.json`)
    writeFileSync(
      filePath,
      JSON.stringify([
        { domain: `.${name}.example`, name, value: 'value', path: '/', secure: true }
      ])
    )
    return filePath
  }

  it('retires a timed-out debugger without releasing serialization before its late write settles', async () => {
    const firstStarted = electron.onFirstCommand()
    const first = importCookiesFromFile(writeCookieSource('first'), 'persist:timeout-oracle')
    await firstStarted

    const second = importCookiesFromFile(writeCookieSource('second'), 'persist:timeout-oracle')
    await vi.advanceTimersByTimeAsync(60_000)

    const whileFirstCanCompleteLate = [...electron.events]
    electron.events.push('A:late-completion')
    electron.firstCommand().resolve({ success: true })
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(whileFirstCanCompleteLate).toEqual(['A:Network.setCookie', 'A:detach', 'A:destroy'])
    expect(firstResult).toEqual({
      ok: false,
      reason: expect.stringContaining('Could not safely replace cookies for the imported sites.')
    })
    expect(secondResult.ok).toBe(true)
    expect(electron.events).toEqual([
      'A:Network.setCookie',
      'A:detach',
      'A:destroy',
      'A:late-completion',
      'rollback:first',
      'B:Network.setCookie',
      'B:detach',
      'B:destroy'
    ])
    expect(electron.windows).toHaveLength(2)
    expect(
      electron.windows.every(
        (window) => window.webContents.debugger.sendCommand.mock.calls.length === 1
      )
    ).toBe(true)
  })
})

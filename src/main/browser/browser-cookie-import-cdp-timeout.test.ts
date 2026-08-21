import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { sendCookieDebuggerCommand } from './browser-cookie-debugger-command'

type CookieDebuggerCommandModule = {
  sendCookieDebuggerCommand: typeof sendCookieDebuggerCommand
}

const electron = vi.hoisted(() => {
  type PendingCommand = {
    promise: Promise<unknown>
    resolve: (value: unknown) => void
  }

  const events: string[] = []
  const windows: BrowserWindow[] = []
  const sessions = new Map<string, ReturnType<typeof createSession>>()
  let firstCommandStarted: () => void = () => undefined
  let firstCommand: PendingCommand
  let userDataPath = ''
  let commandTimeoutEnabled = true

  function createSession(partition: string) {
    return {
      partition,
      cookies: {
        get: vi.fn(async () => []),
        remove: vi.fn(async (_url: string, name: string) => {
          events.push(`remove:${partition}:${name}`)
        })
      }
    }
  }

  function fromPartition(partition: string) {
    let target = sessions.get(partition)
    if (!target) {
      target = createSession(partition)
      sessions.set(partition, target)
    }
    return target
  }

  function reset(): void {
    events.length = 0
    windows.length = 0
    sessions.clear()
    firstCommandStarted = () => undefined
    commandTimeoutEnabled = true
    let resolveCommand!: (value: unknown) => void
    firstCommand = {
      promise: new Promise((resolve) => {
        resolveCommand = resolve
      }),
      resolve: (value) => {
        events.push('A:late-completion')
        resolveCommand(value)
      }
    }
  }

  class BrowserWindow {
    readonly label = String.fromCharCode(65 + windows.length)
    private closed = false
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
      isDestroyed: vi.fn(() => this.closed)
    }

    constructor() {
      windows.push(this)
    }

    async loadURL(): Promise<void> {}

    destroy(): void {
      this.closed = true
      events.push(`${this.label}:destroy`)
    }
  }

  reset()
  return {
    BrowserWindow,
    events,
    firstCommand: () => firstCommand,
    fromPartition,
    isCommandTimeoutEnabled: () => commandTimeoutEnabled,
    onFirstCommand: () =>
      new Promise<void>((resolve) => {
        firstCommandStarted = resolve
      }),
    reset,
    sessions,
    windows,
    getUserDataPath: () => userDataPath,
    setUserDataPath: (value: string) => {
      userDataPath = value
    },
    setCommandTimeoutEnabled: (value: boolean) => {
      commandTimeoutEnabled = value
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: electron.getUserDataPath },
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: vi.fn(electron.fromPartition) },
  BrowserWindow: electron.BrowserWindow
}))

vi.mock('./electron-debugger-lease', () => ({
  acquireElectronDebugger: (contents: { label: string }) => ({
    release: () => {
      electron.events.push(`${contents.label}:detach`)
    }
  })
}))

vi.mock('./browser-cookie-debugger-command', async (importOriginal) => {
  const actual = await importOriginal<CookieDebuggerCommandModule>()
  return {
    ...actual,
    sendCookieDebuggerCommand: (
      ...args: Parameters<typeof actual.sendCookieDebuggerCommand>
    ): ReturnType<typeof actual.sendCookieDebuggerCommand> =>
      electron.isCommandTimeoutEnabled()
        ? actual.sendCookieDebuggerCommand(...args)
        : args[0].debugger.sendCommand(args[1], args[2])
  }
})

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

  it('recovers after retirement proves the late command settled during its grace period', async () => {
    const firstStarted = electron.onFirstCommand()
    const first = importCookiesFromFile(writeCookieSource('first'), 'persist:timeout-oracle')
    await firstStarted

    const second = importCookiesFromFile(writeCookieSource('second'), 'persist:timeout-oracle')
    await vi.advanceTimersByTimeAsync(10_000)

    const whileFirstCanCompleteLate = [...electron.events]
    const firstState = await Promise.race([first.then(() => 'settled'), Promise.resolve('pending')])
    electron.firstCommand().resolve({ success: true })
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(whileFirstCanCompleteLate).toEqual(['A:Network.setCookie', 'A:detach', 'A:destroy'])
    expect(firstState).toBe('pending')
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
      'remove:persist:timeout-oracle:first',
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

  it('fails fast while an orphan is unsettled and reopens only after its late completion', async () => {
    const firstStarted = electron.onFirstCommand()
    const first = importCookiesFromFile(writeCookieSource('first'), 'persist:timeout-oracle')
    await firstStarted
    const second = importCookiesFromFile(writeCookieSource('second'), 'persist:timeout-oracle')

    await vi.advanceTimersByTimeAsync(11_000)
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toEqual({
      ok: false,
      reason: expect.stringContaining('Could not safely replace cookies for the imported sites.')
    })
    expect(secondResult).toEqual({
      ok: false,
      reason:
        'A previous cookie import is still finishing in Chromium. Wait a moment and try again; if it continues, restart Orca.'
    })
    expect(electron.events).toEqual(['A:Network.setCookie', 'A:detach', 'A:destroy'])
    expect(electron.windows).toHaveLength(1)

    const otherResult = await importCookiesFromFile(
      writeCookieSource('other'),
      'persist:other-partition'
    )
    expect(otherResult.ok).toBe(true)

    electron.firstCommand().resolve({ success: true })
    await electron.firstCommand().promise
    await Promise.resolve()
    const recoveredResult = await importCookiesFromFile(
      writeCookieSource('recovered'),
      'persist:timeout-oracle'
    )

    expect(recoveredResult.ok).toBe(true)
    expect(electron.events).toEqual([
      'A:Network.setCookie',
      'A:detach',
      'A:destroy',
      'B:Network.setCookie',
      'B:detach',
      'B:destroy',
      'A:late-completion',
      'C:Network.setCookie',
      'C:detach',
      'C:destroy'
    ])
    expect(electron.windows).toHaveLength(3)
  })

  it('exposes the permanent-blockage signal when retirement is disabled', async () => {
    electron.setCommandTimeoutEnabled(false)
    const firstStarted = electron.onFirstCommand()
    const first = importCookiesFromFile(writeCookieSource('first'), 'persist:timeout-oracle')
    await firstStarted
    const second = importCookiesFromFile(writeCookieSource('second'), 'persist:timeout-oracle')

    await vi.advanceTimersByTimeAsync(60_000)
    const firstState = await Promise.race([first.then(() => 'settled'), Promise.resolve('pending')])
    const secondState = await Promise.race([
      second.then(() => 'settled'),
      Promise.resolve('pending')
    ])

    expect(firstState).toBe('pending')
    expect(secondState).toBe('pending')
    expect(electron.events).toEqual(['A:Network.setCookie'])

    electron.firstCommand().resolve({ success: true })
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.ok).toBe(true)
    expect(secondResult.ok).toBe(true)
    expect(electron.events).toEqual([
      'A:Network.setCookie',
      'A:late-completion',
      'A:detach',
      'A:destroy',
      'B:Network.setCookie',
      'B:detach',
      'B:destroy'
    ])
  })
})

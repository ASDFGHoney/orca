import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../../src/shared/terminal-surface-id'

export type TerminalViewportTarget = {
  hostTabId: string
  sinkPath: string
  terminal: string
  webTabId: string
}

export type TerminalWireFrame = {
  direction: 'in' | 'out'
  opcode?: number
  payload?: unknown
  held?: boolean
}

type WireProbeState = {
  cleanup: () => void
  held: { channel: string; args: unknown[] }[]
  release: () => void
  trace: TerminalWireFrame[]
}

export function createViewportFixture(): {
  command: string
  dispose: () => void
  makeSinkPath: () => string
  readSink: (sinkPath: string) => string
} {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-viewport-ownership-'))
  const fixturePath = path.join(scratch, 'viewport-terminal.mjs')
  writeFileSync(
    fixturePath,
    [
      "import { appendFileSync } from 'node:fs'",
      'const sink = process.argv[2]',
      'const size = () => `${process.stdout.columns}x${process.stdout.rows}`',
      'const record = (line) => appendFileSync(sink, `${line}\\n`)',
      'const publish = (line) => { record(line); process.stdout.write(`${line}\\r\\n`) }',
      'publish(`READY:${size()}`)',
      "process.stdout.on('resize', () => publish(`SIZE:${size()}`))",
      "process.stdin.setEncoding('utf8')",
      "let pending = ''",
      "process.stdin.on('data', (data) => {",
      '  pending += data',
      '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
      "  pending = lines.pop() ?? ''",
      '  for (const line of lines) publish(`LINE:${line}:${size()}`)',
      '})',
      'process.stdin.resume()'
    ].join('\n')
  )
  const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  const quote = (value: string): string =>
    process.platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : shellQuote(value)
  return {
    command: [process.execPath, fixturePath, '__SINK__'].map(quote).join(' '),
    dispose: () => rmSync(scratch, { recursive: true, force: true }),
    makeSinkPath: () => path.join(scratch, `sink-${crypto.randomUUID()}.log`),
    readSink: (sinkPath) => {
      try {
        return readFileSync(sinkPath, 'utf8')
      } catch {
        return ''
      }
    }
  }
}

export async function callEnvironment<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

export async function callLocal<TResult>(
  page: Page,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

export async function createViewportTerminal(
  page: Page,
  environmentId: string,
  worktreeId: string,
  fixture: ReturnType<typeof createViewportFixture>
): Promise<TerminalViewportTarget> {
  const sinkPath = fixture.makeSinkPath()
  const result = await callEnvironment<{ tab: { id: string; terminal: string | null } }>(
    page,
    environmentId,
    'session.tabs.createTerminal',
    {
      worktree: `id:${worktreeId}`,
      command: fixture.command.replace('__SINK__', sinkPath),
      activate: false,
      select: false,
      navigation: 'host'
    }
  )
  if (!result.tab.terminal) {
    throw new Error('viewport fixture terminal was not created')
  }
  const hostTabId = result.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]
  return {
    hostTabId,
    sinkPath,
    terminal: result.tab.terminal,
    webTabId: toWebTerminalSurfaceTabId(hostTabId)
  }
}

export async function openTerminalTab(
  page: Page,
  worktreeId: string,
  tabId: string
): Promise<void> {
  await page.waitForFunction(
    ({ tabId, worktreeId }) =>
      (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId),
    { tabId, worktreeId },
    { timeout: 60_000 }
  )
  await page.evaluate(
    ({ tabId, worktreeId }) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
      state?.setActiveTab(tabId)
      state?.setActiveTabType('terminal')
    },
    { tabId, worktreeId }
  )
  await page.waitForFunction((id) => window.__paneManagers?.has(id) ?? false, tabId, {
    timeout: 60_000
  })
}

export async function readPaneGrid(
  page: Page,
  tabId: string
): Promise<{ cols: number; rows: number }> {
  const grid = await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    return pane ? { cols: pane.terminal.cols, rows: pane.terminal.rows } : null
  }, tabId)
  if (!grid) {
    throw new Error(`terminal pane ${tabId} is unavailable`)
  }
  return grid
}

export async function fitTerminalPane(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    pane?.fitAddon.fit()
  }, tabId)
}

export async function configureElectronWindow(
  app: ElectronApplication,
  width: number,
  height: number,
  focus: boolean
): Promise<void> {
  await app.evaluate(
    ({ app, BrowserWindow }, options) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) {
        throw new Error('Electron window unavailable')
      }
      window.show()
      window.setSize(options.width, options.height)
      if (options.focus) {
        app.focus({ steal: true })
        window.focus()
      } else {
        window.blur()
      }
    },
    { focus, height, width }
  )
}

export async function installTerminalWireProbe(
  app: ElectronApplication,
  options: { holdFitEvents?: boolean; legacyViewportClient?: boolean } = {}
): Promise<void> {
  await app.evaluate(({ BrowserWindow, ipcMain }, probeOptions) => {
    const target = globalThis as typeof globalThis & { __sta5050WireProbe?: WireProbeState }
    target.__sta5050WireProbe?.cleanup()
    const trace: TerminalWireFrame[] = []
    const listener = (_event: unknown, message: { bytes?: Uint8Array }) => {
      const bytes = message.bytes
      if (!bytes || bytes.byteLength < 16) {
        return
      }
      const opcode = bytes[2]
      if (probeOptions.legacyViewportClient && opcode === 9) {
        const text = new TextDecoder().decode(bytes.slice(16))
        const key = 'desktopViewportClaims'
        const offset = text.indexOf(key)
        if (offset !== -1) {
          bytes[16 + offset + key.length - 1] = 'x'.charCodeAt(0)
        }
      }
      if (probeOptions.legacyViewportClient && opcode === 14) {
        bytes[2] = 8
      }
      let payload: unknown
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes.slice(16)))
      } catch {
        payload = undefined
      }
      trace.push({ direction: 'out', opcode: bytes[2], payload })
    }
    ipcMain.prependListener('runtimeEnvironments:subscriptionBinary', listener)
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      throw new Error('Electron window unavailable')
    }
    const originalSend = window.webContents.send.bind(window.webContents)
    const held: { channel: string; args: unknown[] }[] = []
    window.webContents.send = ((channel: string, ...args: unknown[]) => {
      const isFit =
        channel === 'runtimeEnvironments:subscriptionEvent' &&
        JSON.stringify(args).includes('fit-override-changed')
      trace.push({ direction: 'in', held: isFit && probeOptions.holdFitEvents, payload: args })
      if (isFit && probeOptions.holdFitEvents) {
        held.push({ channel, args })
        return
      }
      originalSend(channel, ...args)
    }) as typeof window.webContents.send
    const release = () => {
      for (const event of held.splice(0)) {
        originalSend(event.channel, ...event.args)
      }
    }
    const cleanup = () => {
      release()
      ipcMain.removeListener('runtimeEnvironments:subscriptionBinary', listener)
      window.webContents.send = originalSend
      delete target.__sta5050WireProbe
    }
    target.__sta5050WireProbe = { cleanup, held, release, trace }
  }, options)
}

export async function readTerminalWireProbe(
  app: ElectronApplication
): Promise<TerminalWireFrame[]> {
  return app.evaluate(() => {
    const target = globalThis as typeof globalThis & { __sta5050WireProbe?: WireProbeState }
    return target.__sta5050WireProbe?.trace ?? []
  })
}

export async function releaseTerminalFitEvents(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const target = globalThis as typeof globalThis & { __sta5050WireProbe?: WireProbeState }
    target.__sta5050WireProbe?.release()
  })
}

export async function disposeTerminalWireProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const target = globalThis as typeof globalThis & { __sta5050WireProbe?: WireProbeState }
    target.__sta5050WireProbe?.cleanup()
  })
}

export function lastFixtureGrid(text: string): { cols: number; rows: number } | null {
  const matches = [...text.matchAll(/(?:READY|SIZE|LINE:[^:]+):(\d+)x(\d+)/g)]
  const match = matches.at(-1)
  return match ? { cols: Number(match[1]), rows: Number(match[2]) } : null
}

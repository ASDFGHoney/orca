import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalShow
} from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-probe-gap-'))
const fixturePath = path.join(scratch, 'probe-gap-terminal.mjs')
const processedInputPath = path.join(scratch, 'processed-input.txt')
writeFileSync(processedInputPath, '')
writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const processedInputPath = process.argv[2]',
    "process.stdout.write('PROBE_GAP_READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const commands = pending.split(/\\r\\n|\\r|\\n/)',
    '  pending = commands.pop() ?? ""',
    '  for (const input of commands) {',
    '    appendFileSync(processedInputPath, `${input}\\n`)',
    '    process.stdout.write(`LIVE:${input}\\r\\n`)',
    "    if (input.startsWith('PROBE_GAP_HISTORY_')) {",
    '      for (let line = 0; line < 120; line += 1) process.stdout.write(`SCROLL_FILL_${line}\\r\\n`)',
    '    }',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(): string {
  const command = [process.execPath, fixturePath, processedInputPath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

async function callEnvironment<TResult>(
  client: PairedElectronClient,
  method: string,
  params: unknown
): Promise<TResult> {
  return client.page.evaluate(
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
    { environmentId: client.environmentId, method, params }
  ) as Promise<TResult>
}

async function getXtermBufferState(
  page: Page,
  tabId: string,
  marker: string
): Promise<{ baseY: number; eraseParams: number[]; hasMarker: boolean }> {
  return page.evaluate(
    ({ marker, tabId }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const buffer = pane?.terminal.buffer.active
      if (!buffer) {
        return { baseY: 0, eraseParams: [], hasMarker: false }
      }
      const eraseParams = JSON.parse(pane.container.dataset.e2eEraseParams ?? '[]') as number[]
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer.getLine(index)?.translateToString(true).includes(marker)) {
          return { baseY: buffer.baseY, eraseParams, hasMarker: true }
        }
      }
      return { baseY: buffer.baseY, eraseParams, hasMarker: false }
    },
    { marker, tabId }
  )
}

async function observeXtermEraseInDisplay(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Remote terminal pane was not mounted')
    }
    pane.container.dataset.e2eEraseParams = '[]'
    pane.terminal.parser.registerCsiHandler({ final: 'J' }, (params) => {
      const observed = JSON.parse(pane.container.dataset.e2eEraseParams ?? '[]') as number[]
      observed.push(params.length === 0 ? 0 : params[0])
      pane.container.dataset.e2eEraseParams = JSON.stringify(observed)
      return false
    })
  }, tabId)
}

test('replaces a stale paired stream when the PTY snapshot advanced @headful', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(150_000)
  const host = await launchHeadlessPairedRuntimeHost()
  await host.client.call('repo.add', { path: testRepoPath, kind: 'git' }).catch(async (error) => {
    await host.dispose()
    throw error
  })
  const client = await launchPairedElectronClient(host.offer, testInfo, 'probe-gap-client').catch(
    async (error) => {
      await host.dispose()
      throw error
    }
  )
  let terminal: string | null = null
  try {
    await expect
      .poll(
        () => client.page.evaluate(() => window.__store?.getState().allWorktrees().length ?? 0),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)
    const worktreeId = await client.page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? null
    )
    if (!worktreeId) {
      throw new Error('Paired client did not receive the host worktree')
    }
    const created = await callEnvironment<{
      tab: { parentTabId: string; terminal: string | null }
    }>(client, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      command: fixtureCommand(),
      activate: false,
      select: false,
      navigation: 'caller'
    })
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Paired runtime did not publish the probe-gap fixture')
    }
    const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await client.page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
    const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    await expect(tab).toHaveAttribute('data-active', 'true')
    const originalPtyId = await waitForActivePanePtyId(client.page, 30_000)
    const originalHostTerminal = await callEnvironment<{ terminal: RuntimeTerminalShow }>(
      client,
      'terminal.show',
      { terminal }
    )
    expect(originalHostTerminal.terminal.ptyId).not.toBeNull()
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('PROBE_GAP_READY')
    const textarea = client.page.locator('.xterm-helper-textarea:visible').first()
    await textarea.focus()

    const historyMarker = `PROBE_GAP_HISTORY_${Date.now()}`
    await client.page.keyboard.type(historyMarker)
    await client.page.keyboard.press('Enter')
    await expect
      .poll(() => getTerminalContent(client.page, 20_000), { timeout: 10_000 })
      .toContain('SCROLL_FILL_119')
    await expect
      .poll(() => readFileSync(processedInputPath, 'utf8'))
      .toContain(`${historyMarker}\n`)
    await expect
      .poll(() => getXtermBufferState(client.page, webTabId, `LIVE:${historyMarker}`))
      .toMatchObject({ hasMarker: true })
    expect((await getXtermBufferState(client.page, webTabId, historyMarker)).baseY).toBeGreaterThan(
      0
    )
    await observeXtermEraseInDisplay(client.page, webTabId)

    expect(
      await client.page.evaluate((target) => {
        const gate = (
          window as typeof window & {
            __remoteTerminalMultiplexAckGate?: {
              dropOutputUntilResubscribe: (terminals: string[]) => number
            }
          }
        ).__remoteTerminalMultiplexAckGate
        if (!gate) {
          throw new Error('Remote terminal multiplex output gate is unavailable')
        }
        return gate.dropOutputUntilResubscribe([target])
      }, terminal)
    ).toBe(1)
    const missingMarker = `PROBE_GAP_MISSING_${Date.now()}`
    await client.page.keyboard.type(missingMarker)
    await client.page.keyboard.press('Enter')

    await expect
      .poll(
        () =>
          client.page.evaluate(() => {
            const gate = (
              window as typeof window & {
                __remoteTerminalMultiplexAckGate?: {
                  snapshot: () => { droppedOutputFrames: number }
                }
              }
            ).__remoteTerminalMultiplexAckGate
            return gate?.snapshot().droppedOutputFrames ?? 0
          }),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0)
    await expect
      .poll(() => readFileSync(processedInputPath, 'utf8'), { timeout: 10_000 })
      .toContain(`${missingMarker}\n`)
    await expect
      .poll(
        async () => {
          const result = await callEnvironment<{ terminal: RuntimeTerminalRead }>(
            client,
            'terminal.read',
            { terminal }
          )
          return result.terminal.tail.join('\n')
        },
        { timeout: 10_000 }
      )
      .toContain(missingMarker)
    expect(await getTerminalContent(client.page)).not.toContain(`LIVE:${missingMarker}`)

    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 20_000 })
      .toContain(`LIVE:${missingMarker}`)
    const recoveredBuffer = await getXtermBufferState(
      client.page,
      webTabId,
      `LIVE:${historyMarker}`
    )
    expect(recoveredBuffer.eraseParams).not.toContain(3)
    expect(recoveredBuffer).toMatchObject({ hasMarker: true })
    expect(readFileSync(processedInputPath, 'utf8')).toContain(`${historyMarker}\n`)
    await expect(tab).toHaveAttribute('data-active', 'true')
    expect(await waitForActivePanePtyId(client.page, 30_000)).toBe(originalPtyId)
    const recoveredHostTerminal = await callEnvironment<{ terminal: RuntimeTerminalShow }>(
      client,
      'terminal.show',
      { terminal }
    )
    expect(recoveredHostTerminal.terminal.ptyId).toBe(originalHostTerminal.terminal.ptyId)
    const hostTerminals = await callEnvironment<RuntimeTerminalListResult>(
      client,
      'terminal.list',
      {
        worktree: `id:${worktreeId}`,
        requireFreshPtyLiveness: true
      }
    )
    expect(
      hostTerminals.terminals
        .filter((candidate) => candidate.tabId === created.tab.parentTabId)
        .map((candidate) => ({ handle: candidate.handle, ptyId: candidate.ptyId }))
    ).toEqual([{ handle: terminal, ptyId: originalHostTerminal.terminal.ptyId }])

    const liveMarker = `PROBE_GAP_LIVE_${Date.now()}`
    await textarea.focus()
    await client.page.keyboard.type(liveMarker)
    await client.page.keyboard.press('Enter')
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 10_000 })
      .toContain(`LIVE:${liveMarker}`)
    await expect
      .poll(() => readFileSync(processedInputPath, 'utf8'), { timeout: 10_000 })
      .toContain(`${liveMarker}\n`)
    expect(await waitForActivePanePtyId(client.page, 30_000)).toBe(originalPtyId)
  } finally {
    await client.page
      .evaluate(() => {
        ;(
          window as typeof window & {
            __remoteTerminalMultiplexAckGate?: { release: () => void }
          }
        ).__remoteTerminalMultiplexAckGate?.release()
      })
      .catch(() => undefined)
    if (terminal) {
      await callEnvironment(client, 'terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client.dispose()
    await host.dispose()
  }
})

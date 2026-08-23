import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { AgentHookEndpoint } from '../../src/shared/agent-hook-endpoint-file'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from '../../src/renderer/src/runtime/window-visibility-subscription-parking'
import { expect, test } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { revealPairedClientWindow } from './helpers/paired-client-window-reveal'

type NotificationDispatch = { source?: string; agentState?: string; worktreeId?: string }
type AgentStatusSummary = { state: string; prompt: string; agentType?: string }
type TerminalSurface = Extract<RuntimeMobileSessionTabsResult['tabs'][number], { type: 'terminal' }>

async function callEnvironment<TResult>(
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

async function installNotificationDispatchSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as unknown as { __sta5244Dispatches?: NotificationDispatch[] }
    state.__sta5244Dispatches = []
    ipcMain.removeHandler('notifications:dispatch')
    ipcMain.handle('notifications:dispatch', (_event: unknown, input: NotificationDispatch) => {
      state.__sta5244Dispatches!.push(input)
      return { delivered: true }
    })
  })
}

async function notificationDispatches(app: ElectronApplication): Promise<NotificationDispatch[]> {
  return app.evaluate(() => {
    const state = globalThis as unknown as { __sta5244Dispatches?: NotificationDispatch[] }
    return state.__sta5244Dispatches ?? []
  })
}

async function postClaudeHook(
  endpoint: AgentHookEndpoint,
  paneKey: string,
  worktreeId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const [tabId] = paneKey.split(':')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey,
      tabId,
      worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      payload
    })
  })
  expect(response.status).toBe(204)
}

async function hostSurface(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string,
  parentTabId: string
): Promise<TerminalSurface | null> {
  const snapshot = (
    await host.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree: `id:${worktreeId}`
    })
  ).result
  const surface = snapshot.tabs.find(
    (candidate): candidate is TerminalSurface =>
      candidate.type === 'terminal' && candidate.parentTabId === parentTabId
  )
  return surface ?? null
}

async function clientStatus(page: Page, paneKey: string): Promise<AgentStatusSummary | null> {
  return page.evaluate((key) => {
    const status = window.__store?.getState().agentStatusByPaneKey[key]
    return status
      ? { state: status.state, prompt: status.prompt, agentType: status.agentType }
      : null
  }, paneKey)
}

async function unreadBadgeState(
  client: PairedElectronClient,
  worktreeId: string
): Promise<{ dock: string | null; unread: boolean; unreadCount: number }> {
  const renderer = await client.page.evaluate((id) => {
    const state = window.__store?.getState()
    const worktrees = state?.allWorktrees() ?? []
    return {
      unread: worktrees.find((worktree) => worktree.id === id)?.isUnread === true,
      unreadCount: worktrees.filter((worktree) => worktree.isUnread).length
    }
  }, worktreeId)
  const dock = await client.app.evaluate(({ app }) => app.dock?.getBadge() ?? null)
  return { ...renderer, dock }
}

async function hideUntilSubscriptionsPark(client: PairedElectronClient): Promise<void> {
  await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide())
  await expect
    .poll(() =>
      client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
    )
    .toBe(false)
  await client.page.evaluate(() => {
    if (document.visibilityState === 'hidden') {
      return
    }
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden'
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await client.page.waitForTimeout(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS + 100)
}

async function revealAfterSubscriptionsPark(client: PairedElectronClient): Promise<void> {
  await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
  await client.page.evaluate(() => {
    if (document.visibilityState === 'visible') {
      return
    }
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible'
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await revealPairedClientWindow(client)
}

async function reconnect(client: PairedElectronClient): Promise<void> {
  await client.page.evaluate(async (selector) => {
    await window.api.runtimeEnvironments.disconnect({ selector })
  }, client.environmentId)
  await expect
    .poll(
      () =>
        client.page.evaluate(async (selector) => {
          const response = await window.api.runtimeEnvironments.connect({ selector })
          return response.ok
        }, client.environmentId),
      { timeout: 60_000, message: 'paired client did not reconnect' }
    )
    .toBe(true)
}

async function clearUnread(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.__store?.getState().updateWorktreeMeta(id, { isUnread: false })
  }, worktreeId)
}

test('recovers hidden remote completion and permission alerts exactly once', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(360_000)
  const screenshots = path.join(process.cwd(), 'validation-screenshots', 'sta-5244')
  mkdirSync(screenshots, { recursive: true })
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  let coldClient: PairedElectronClient | null = null
  let terminal: string | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'STA-5244 headless host')
    const worktreeId = await expect
      .poll(
        () => client?.page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id) ?? null,
        { timeout: 60_000, message: 'paired client did not receive the host worktree' }
      )
      .not.toBeNull()
      .then(() => client!.page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id))
    if (!worktreeId) {
      throw new Error('Host worktree disappeared after pairing')
    }

    const created = await callEnvironment<{
      tab: { parentTabId: string; terminal: string | null }
    }>(client.page, client.environmentId, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      activate: false,
      select: false,
      navigation: 'caller'
    })
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Headless host did not create a terminal')
    }
    const surface = await expect
      .poll(() => hostSurface(host, worktreeId, created.tab.parentTabId), {
        timeout: 30_000,
        message: 'headless host did not publish the terminal surface'
      })
      .not.toBeNull()
      .then(() => hostSurface(host, worktreeId, created.tab.parentTabId))
    if (!surface) {
      throw new Error('Headless host terminal surface disappeared')
    }
    const hostPaneKey = makePaneKey(surface.parentTabId, surface.leafId)
    const clientPaneKey = makePaneKey(
      toWebTerminalSurfaceTabId(surface.parentTabId),
      surface.leafId
    )
    const endpoint = await readHookEndpoint(host.app)
    expect(Number(endpoint.port)).toBeGreaterThan(0)

    const completionPrompt = `STA-5244 completion ${Date.now()}`
    await postClaudeHook(endpoint, hostPaneKey, worktreeId, {
      hook_event_name: 'UserPromptSubmit',
      prompt: completionPrompt
    })
    await expect
      .poll(() => hostSurface(host, worktreeId, surface.parentTabId), {
        timeout: 30_000,
        message: 'managed host hook row did not reach the session-tab snapshot'
      })
      .toMatchObject({ agentStatus: { state: 'working', prompt: completionPrompt } })
    await expect
      .poll(() => clientStatus(client!.page, clientPaneKey), {
        timeout: 30_000,
        message: 'paired client did not mirror the managed working hook row'
      })
      .toMatchObject({ state: 'working', prompt: completionPrompt })
    await installNotificationDispatchSpy(client.app)

    await hideUntilSubscriptionsPark(client)
    await postClaudeHook(endpoint, hostPaneKey, worktreeId, {
      hook_event_name: 'Stop',
      last_assistant_message: 'STA-5244 completed while hidden'
    })
    await expect
      .poll(() => hostSurface(host, worktreeId, surface.parentTabId), {
        timeout: 30_000,
        message: 'headless host did not publish done'
      })
      .toMatchObject({ agentStatus: { state: 'done' } })
    await expect(clientStatus(client.page, clientPaneKey)).resolves.toMatchObject({
      state: 'working'
    })

    await revealAfterSubscriptionsPark(client)
    await expect
      .poll(() => clientStatus(client!.page, clientPaneKey), {
        timeout: 30_000,
        message: 'paired client did not mirror done after reveal'
      })
      .toMatchObject({ state: 'done' })
    await expect
      .poll(() => notificationDispatches(client!.app), { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({
          source: 'agent-task-complete',
          agentState: 'done',
          worktreeId
        })
      ])
    await expect
      .poll(() => unreadBadgeState(client!, worktreeId))
      .toMatchObject({
        unread: true,
        unreadCount: 1,
        dock: process.platform === 'darwin' ? '1' : null
      })
    await expect(
      client.page.locator(`[data-worktree-id=${JSON.stringify(worktreeId)}]`).first()
    ).toContainText('Done')
    await client.page.screenshot({ path: path.join(screenshots, '01-hidden-done-pass.png') })

    await clearUnread(client.page, worktreeId)
    await expect
      .poll(() => unreadBadgeState(client!, worktreeId))
      .toMatchObject({
        unread: false,
        unreadCount: 0,
        dock: process.platform === 'darwin' ? '' : null
      })

    const permissionPrompt = `STA-5244 permission ${Date.now()}`
    await postClaudeHook(endpoint, hostPaneKey, worktreeId, {
      hook_event_name: 'UserPromptSubmit',
      prompt: permissionPrompt
    })
    await expect
      .poll(() => clientStatus(client!.page, clientPaneKey), { timeout: 30_000 })
      .toMatchObject({ state: 'working', prompt: permissionPrompt })

    await hideUntilSubscriptionsPark(client)
    await postClaudeHook(endpoint, hostPaneKey, worktreeId, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git status' }
    })
    await expect
      .poll(() => hostSurface(host, worktreeId, surface.parentTabId), {
        timeout: 30_000,
        message: 'headless host did not publish the permission wait'
      })
      .toMatchObject({ agentStatus: { state: 'waiting', toolName: 'Bash' } })
    await expect(clientStatus(client.page, clientPaneKey)).resolves.toMatchObject({
      state: 'working'
    })

    await revealAfterSubscriptionsPark(client)
    await expect
      .poll(() => clientStatus(client!.page, clientPaneKey), {
        timeout: 30_000,
        message: 'paired client did not mirror permission wait after reveal'
      })
      .toMatchObject({ state: 'waiting' })
    await expect
      .poll(() => notificationDispatches(client!.app), { timeout: 30_000 })
      .toEqual([
        expect.objectContaining({ agentState: 'done', worktreeId }),
        expect.objectContaining({ agentState: 'waiting', worktreeId })
      ])
    await expect
      .poll(() => unreadBadgeState(client!, worktreeId))
      .toMatchObject({
        unread: true,
        unreadCount: 1,
        dock: process.platform === 'darwin' ? '1' : null
      })
    await expect(
      client.page.locator(`[data-worktree-id=${JSON.stringify(worktreeId)}]`).first()
    ).toContainText('Needs permission')
    await client.page.screenshot({ path: path.join(screenshots, '03-hidden-permission-pass.png') })

    await hideUntilSubscriptionsPark(client)
    await revealAfterSubscriptionsPark(client)
    await expect.poll(() => notificationDispatches(client!.app)).toHaveLength(2)
    await reconnect(client)
    await expect.poll(() => notificationDispatches(client!.app)).toHaveLength(2)

    await clearUnread(client.page, worktreeId)
    await expect
      .poll(() => unreadBadgeState(client!, worktreeId))
      .toMatchObject({
        unread: false,
        unreadCount: 0,
        dock: process.platform === 'darwin' ? '' : null
      })
    coldClient = await launchPairedElectronClient(host.offer, testInfo, 'STA-5244 cold replay')
    await expect
      .poll(() => clientStatus(coldClient!.page, clientPaneKey), {
        timeout: 30_000,
        message: 'cold client did not hydrate terminal permission state'
      })
      .toMatchObject({ state: 'waiting' })
    expect(await unreadBadgeState(coldClient, worktreeId)).toMatchObject({
      unread: false,
      unreadCount: 0,
      dock: process.platform === 'darwin' ? '' : null
    })
    await installNotificationDispatchSpy(coldClient.app)
    await reconnect(coldClient)
    await expect.poll(() => notificationDispatches(coldClient!.app)).toHaveLength(0)
    await coldClient.page.screenshot({
      path: path.join(screenshots, '02-cold-permission-silent.png')
    })
  } finally {
    await coldClient?.dispose()
    if (terminal) {
      await host.client.call('terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client?.dispose()
    await host.dispose()
  }
})

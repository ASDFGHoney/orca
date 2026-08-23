import type { Page, TestInfo } from '@stablyai/playwright-test'

import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { focusActiveTerminalInput } from './helpers/terminal'
import {
  callLocal,
  configureElectronWindow,
  createViewportFixture,
  createViewportTerminal,
  disposeTerminalWireProbe,
  fitTerminalPane,
  installTerminalWireProbe,
  lastFixtureGrid,
  openTerminalTab,
  readPaneGrid,
  readTerminalWireProbe,
  releaseTerminalFitEvents,
  type TerminalViewportTarget
} from './helpers/terminal-viewport-ownership-fixture'

const fixture = createViewportFixture()

test.afterAll(() => fixture.dispose())

async function waitForWorktree(client: PairedElectronClient, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        client.page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.id === id) ?? false,
          worktreeId
        ),
      { timeout: 60_000, message: 'paired client never received the host worktree' }
    )
    .toBe(true)
}

async function focusApp(client: PairedElectronClient): Promise<void> {
  await configureElectronWindow(client.app, 1100, 720, true)
  await client.page.bringToFront()
  await expect.poll(() => client.page.evaluate(() => document.hasFocus())).toBe(true)
}

async function forceDocumentUnfocused(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false
    })
  })
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
}

async function typeMarker(page: Page, marker: string): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.evaluate((value) => {
    const state = window.__store?.getState()
    const manager = state?.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!pane) {
      throw new Error('active terminal pane unavailable for input')
    }
    pane.terminal.input(`${value}\r`, true)
  }, marker)
}

async function waitForSink(target: TerminalViewportTarget, marker: string): Promise<string> {
  await expect
    .poll(() => fixture.readSink(target.sinkPath), {
      timeout: 30_000,
      message: `host fixture never observed ${marker}`
    })
    .toContain(marker)
  return fixture.readSink(target.sinkPath)
}

async function waitForGrid(
  target: TerminalViewportTarget,
  grid: { cols: number; rows: number }
): Promise<void> {
  const expected = clampGrid(grid)
  await expect
    .poll(() => lastFixtureGrid(fixture.readSink(target.sinkPath)), {
      timeout: 30_000,
      message: `PTY never reached ${expected.cols}x${expected.rows}`
    })
    .toEqual(expected)
}

function clampGrid(grid: { cols: number; rows: number }): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.min(240, Math.round(grid.cols))),
    rows: Math.max(8, Math.min(120, Math.round(grid.rows)))
  }
}

async function runtimeTail(page: Page, terminal: string): Promise<string> {
  const result = await callLocal<{ terminal: { tail: string[] } }>(page, 'terminal.read', {
    terminal
  })
  return result.terminal.tail.join('\n')
}

async function captureVersions(hostPage: Page, clients: PairedElectronClient[]): Promise<unknown> {
  const hostStatus = await callLocal<{
    appVersion?: string
    capabilities?: string[]
  }>(hostPage, 'status.get', {})
  const clientVersions = await Promise.all(
    clients.map((client) => client.app.evaluate(({ app }) => app.getVersion()))
  )
  return { clientVersions, hostStatus }
}

async function screenshotTopology(
  testInfo: TestInfo,
  hostPage: Page,
  clients: PairedElectronClient[]
): Promise<void> {
  await hostPage.screenshot({ path: testInfo.outputPath('sta5050-host.png') })
  await clients[0]?.page.screenshot({ path: testInfo.outputPath('sta5050-client-a.png') })
  await clients[1]?.page.screenshot({ path: testInfo.outputPath('sta5050-client-b.png') })
}

test('current clients keep viewport ownership with real activity @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('headed host has no active worktree')
  }
  const createdClients: PairedElectronClient[] = []
  let target: TerminalViewportTarget | null = null
  let clientA: PairedElectronClient | null = null
  let clientB: PairedElectronClient | null = null
  try {
    clientA = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-5050 active client A'
    )
    createdClients.push(clientA)
    await waitForWorktree(clientA, worktreeId)
    target = await createViewportTerminal(clientA.page, clientA.environmentId, worktreeId, fixture)
    await configureElectronWindow(electronApp, 1500, 900, true)
    await openTerminalTab(orcaPage, worktreeId, target.hostTabId)
    await waitForSink(target, 'READY:')
    const hostGrid = await readPaneGrid(orcaPage, target.hostTabId)
    await configureElectronWindow(clientA.app, 1120, 720, true)
    await openTerminalTab(clientA.page, worktreeId, target.webTabId)
    await focusApp(clientA)
    await typeMarker(clientA.page, 'A_OWNER')
    await waitForSink(target, 'LINE:A_OWNER:')
    const clientAGrid = await readPaneGrid(clientA.page, target.webTabId)
    await waitForGrid(target, clientAGrid)

    clientB = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-5050 passive client B'
    )
    createdClients.push(clientB)
    await waitForWorktree(clientB, worktreeId)
    await configureElectronWindow(clientB.app, 760, 520, false)
    await installTerminalWireProbe(clientB.app, { holdFitEvents: true })
    await focusApp(clientA)
    await openTerminalTab(clientB.page, worktreeId, target.webTabId)
    await expect
      .poll(() => readTerminalWireProbe(clientB!.app))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'out',
            opcode: 9,
            payload: expect.objectContaining({
              capabilities: expect.objectContaining({ desktopViewportClaims: 1 })
            })
          })
        ])
      )
    await configureElectronWindow(clientB.app, 760, 520, false)
    await focusApp(clientA)
    await forceDocumentUnfocused(clientB.page)
    const passiveAttachGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))
    const unfocusedVisible = await clientB.page.evaluate(() => ({
      focused: document.hasFocus(),
      visibility: document.visibilityState
    }))
    expect(unfocusedVisible).toEqual({ focused: false, visibility: 'visible' })

    await configureElectronWindow(clientB.app, 700, 480, false)
    await focusApp(clientA)
    await expect.poll(() => clientB!.page.evaluate(() => document.hasFocus())).toBe(false)
    await fitTerminalPane(clientB.page, target.webTabId)
    await expect
      .poll(() => readTerminalWireProbe(clientB!.app), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'out', opcode: 8 })]))
    const clientBGrid = clampGrid(await readPaneGrid(clientB.page, target.webTabId))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const raceGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))
    const runtimeRaceTail = await runtimeTail(orcaPage, target.terminal)

    await releaseTerminalFitEvents(clientB.app)
    await focusApp(clientA)
    await typeMarker(clientA.page, 'A_RECLAIM')
    await waitForSink(target, 'LINE:A_RECLAIM:')
    await waitForGrid(target, clientAGrid)

    const claimsBeforeBackgroundResize = (await readTerminalWireProbe(clientB.app)).filter(
      (frame) => frame.opcode === 14
    ).length
    await configureElectronWindow(clientB.app, 660, 460, false)
    await focusApp(clientA)
    await expect.poll(() => clientB!.page.evaluate(() => document.hasFocus())).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const finalWireTrace = await readTerminalWireProbe(clientB.app)
    const claimsAfterBackgroundResize = finalWireTrace.filter((frame) => frame.opcode === 14).length
    const backgroundGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))

    await configureElectronWindow(electronApp, 1500, 900, true)
    await orcaPage.bringToFront()
    await typeMarker(orcaPage, 'HOST_RECLAIM')
    await waitForSink(target, 'LINE:HOST_RECLAIM:')
    await waitForGrid(target, hostGrid)

    await focusApp(clientA)
    await typeMarker(clientA.page, 'A_DETACH_OWNER')
    await waitForSink(target, 'LINE:A_DETACH_OWNER:')
    await waitForGrid(target, clientAGrid)
    await screenshotTopology(testInfo, orcaPage, [clientA, clientB])
    await disposeTerminalWireProbe(clientB.app)
    await clientA.dispose()
    createdClients.splice(createdClients.indexOf(clientA), 1)
    clientA = null
    await new Promise((resolve) => setTimeout(resolve, 500))
    const detachGrid = lastFixtureGrid(fixture.readSink(target.sinkPath))

    const evidence = {
      backgroundGrid,
      claimsAfterBackgroundResize,
      claimsBeforeBackgroundResize,
      clientAGrid,
      clientBGrid,
      detachGrid,
      hostGrid,
      passiveAttachGrid,
      raceGrid,
      runtimeRaceTailHasGrid: runtimeRaceTail.includes(
        `SIZE:${clientBGrid.cols}x${clientBGrid.rows}`
      ),
      unfocusedVisible,
      versions: await captureVersions(orcaPage, [clientB]),
      wireFrames: finalWireTrace.filter((frame) => frame.opcode === 8 || frame.opcode === 14)
    }
    console.log(`[sta5050-current] ${JSON.stringify(evidence)}`)
    expect(evidence).toMatchObject({
      backgroundGrid: clientAGrid,
      claimsAfterBackgroundResize: claimsBeforeBackgroundResize,
      detachGrid: hostGrid,
      passiveAttachGrid: clientAGrid,
      raceGrid: clientAGrid,
      runtimeRaceTailHasGrid: false,
      unfocusedVisible: { focused: false, visibility: 'visible' }
    })
  } finally {
    if (clientB) {
      await disposeTerminalWireProbe(clientB.app).catch(() => undefined)
    }
    for (const client of createdClients.toReversed()) {
      await client.dispose().catch(() => undefined)
    }
    if (target) {
      await callLocal(orcaPage, 'terminal.closeTab', { terminal: target.terminal }).catch(
        () => undefined
      )
    }
  }
})

test('legacy clients retain resize-as-activity compatibility @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('headed host has no active worktree')
  }
  let target: TerminalViewportTarget | null = null
  let active: PairedElectronClient | null = null
  let legacy: PairedElectronClient | null = null
  try {
    active = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-5050 current owner'
    )
    await waitForWorktree(active, worktreeId)
    target = await createViewportTerminal(active.page, active.environmentId, worktreeId, fixture)
    await openTerminalTab(active.page, worktreeId, target.webTabId)
    await focusApp(active)
    await typeMarker(active.page, 'CURRENT_OWNER')
    const activeGrid = await readPaneGrid(active.page, target.webTabId)
    await waitForGrid(target, activeGrid)

    legacy = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-5050 legacy observer'
    )
    await waitForWorktree(legacy, worktreeId)
    await configureElectronWindow(legacy.app, 700, 480, false)
    await installTerminalWireProbe(legacy.app, { legacyViewportClient: true })
    await focusApp(active)
    await openTerminalTab(legacy.page, worktreeId, target.webTabId)
    const legacyGrid = clampGrid(await readPaneGrid(legacy.page, target.webTabId))
    await waitForGrid(target, legacyGrid)
    const trace = await readTerminalWireProbe(legacy.app)
    const outgoingFrames = trace.filter((frame) => frame.direction === 'out')
    console.log(
      `[sta5050-legacy] ${JSON.stringify({ activeGrid, legacyGrid, trace: outgoingFrames })}`
    )
    expect(lastFixtureGrid(fixture.readSink(target.sinkPath))).toEqual(legacyGrid)
    expect(outgoingFrames.some((frame) => frame.opcode === 14)).toBe(false)
    expect(JSON.stringify(outgoingFrames)).not.toContain('desktopViewportClaims')
  } finally {
    if (legacy) {
      await disposeTerminalWireProbe(legacy.app).catch(() => undefined)
    }
    await legacy?.dispose().catch(() => undefined)
    await active?.dispose().catch(() => undefined)
    if (target) {
      await callLocal(orcaPage, 'terminal.closeTab', { terminal: target.terminal }).catch(
        () => undefined
      )
    }
  }
})

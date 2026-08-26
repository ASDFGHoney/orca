import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * The sidebar's remote-host verdict, rendered.
 *
 * A store-slice test cannot see that "no probe yet" and "probe said unreachable"
 * used to collapse into the same red glyph and dimmed card, because the collapse
 * happened in the selector feeding the card's render (#16516).
 */
const REMOTE_HOST = 'E2E Recovery Host'
const REMOTE_PROJECT = 'E2E Recovery Remote Project'
const REMOTE_WORKSPACE = 'E2E Recovery Remote Workspace'

type GlyphFixture = { environmentId: string; worktreeId: string }

async function seedRuntimeHostWorkspace(page: Page): Promise<GlyphFixture> {
  return page.evaluate(
    ({ remoteHost, remoteProject, remoteWorkspace }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const sourceRepo = state.repos[0]
      const sourceWorktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.repoId === sourceRepo?.id && !worktree.isArchived)
      if (!sourceRepo || !sourceWorktree) {
        throw new Error('Runtime host glyph E2E needs the seeded local repository')
      }

      const token = crypto.randomUUID()
      const environmentId = `e2e-recovery-env-${token}`
      const hostId: `runtime:${string}` = `runtime:${environmentId}`
      const remoteRepoId = `e2e-recovery-repo-${token}`
      const worktreeId = `e2e-recovery-worktree-${token}`
      const now = Date.now()
      const remoteWorktree: (typeof state.worktreesByRepo)[string][number] = {
        ...sourceWorktree,
        id: worktreeId,
        repoId: remoteRepoId,
        path: `${sourceWorktree.path}-e2e-recovery-${token}`,
        displayName: remoteWorkspace,
        branch: 'refs/heads/e2e-recovery',
        isMainWorktree: false,
        isArchived: false,
        hostId
      }

      store.setState({
        runtimeEnvironments: [
          {
            id: environmentId,
            name: remoteHost,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: now,
            runtimeId: `${environmentId}-runtime`,
            source: 'manual',
            preferredEndpointId: `ws-${environmentId}`,
            endpoints: [
              {
                id: `ws-${environmentId}`,
                kind: 'websocket',
                label: remoteHost,
                endpoint: 'ws://127.0.0.1:6768'
              }
            ]
          }
        ],
        // Start with no entry at all: the state right after launch, before the
        // boot probe has answered for this host.
        runtimeStatusByEnvironmentId: new Map(),
        repos: [
          ...state.repos,
          {
            ...sourceRepo,
            id: remoteRepoId,
            path: `${sourceRepo.path}-e2e-recovery-${token}`,
            displayName: remoteProject,
            connectionId: undefined,
            executionHostId: hostId
          }
        ],
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [remoteRepoId]: [remoteWorktree]
        }
      })

      return { environmentId, worktreeId }
    },
    { remoteHost: REMOTE_HOST, remoteProject: REMOTE_PROJECT, remoteWorkspace: REMOTE_WORKSPACE }
  )
}

async function recordProbeResult(
  page: Page,
  fixture: GlyphFixture,
  reachable: boolean
): Promise<void> {
  await page.evaluate(
    ({ environmentId, reachable }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      store.setState({
        runtimeStatusByEnvironmentId: new Map(store.getState().runtimeStatusByEnvironmentId).set(
          environmentId,
          {
            checkedAt: Date.now(),
            status: reachable
              ? {
                  runtimeId: `${environmentId}-runtime`,
                  rendererGraphEpoch: 1,
                  graphStatus: 'ready',
                  authoritativeWindowId: 1,
                  desktopWindowStatus: 'available',
                  liveTabCount: 0,
                  liveLeafCount: 0
                }
              : null
          }
        )
      })
    },
    { environmentId: fixture.environmentId, reachable }
  )
}

function card(page: Page, fixture: GlyphFixture) {
  return page.locator(`[data-worktree-id="${fixture.worktreeId}"]`)
}

function surface(page: Page, fixture: GlyphFixture) {
  return card(page, fixture).locator('[data-worktree-card-surface="true"]')
}

/** Why by host name, not by copy: the harness runs in the user's locale. */
async function dismissTooltips(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  // Radix fades the tooltip out; screenshotting mid-fade paints it over the card.
  await expect(page.getByRole('tooltip').filter({ hasText: REMOTE_HOST })).toHaveCount(0)
}

async function readHostTooltip(page: Page, fixture: GlyphFixture, glyph: string): Promise<string> {
  await dismissTooltips(page)
  await card(page, fixture).locator(glyph).hover()
  const tooltip = page.getByRole('tooltip').filter({ hasText: REMOTE_HOST })
  await expect(tooltip).toBeVisible()
  return (await tooltip.innerText()).trim()
}

test.describe('Sidebar runtime host disconnected glyph', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('separates an unprobed remote host from one a probe reported unreachable', async ({
    orcaPage
  }, testInfo) => {
    const fixture = await seedRuntimeHostWorkspace(orcaPage)
    await expect(card(orcaPage, fixture)).toBeVisible()

    // P1: never probed. The host is unverifiable, not down — a plain server glyph
    // on a full-opacity card. This is what regressed for every remote card at launch.
    await expect(card(orcaPage, fixture).locator('svg.lucide-server')).toBeVisible()
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toHaveCount(0)
    await expect(surface(orcaPage, fixture)).not.toHaveClass(/opacity-60/)
    await card(orcaPage, fixture).screenshot({
      path: testInfo.outputPath('runtime-host-glyph-before-probe.png')
    })

    // P2: the probe answered "unreachable". Now, and only now, the card says so.
    await recordProbeResult(orcaPage, fixture, false)
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toBeVisible()
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toHaveClass(
      /text-destructive/
    )
    await expect(surface(orcaPage, fixture)).toHaveClass(/opacity-60/)
    const disconnectedTooltip = await readHostTooltip(orcaPage, fixture, 'svg.lucide-server-off')
    expect(disconnectedTooltip).toContain(REMOTE_HOST)
    await dismissTooltips(orcaPage)
    await card(orcaPage, fixture).screenshot({
      path: testInfo.outputPath('runtime-host-glyph-disconnected.png')
    })

    // P3: a later probe finds it reachable — the card recovers without a reload.
    // Before the fix nothing could reach this state on its own after a boot failure.
    await recordProbeResult(orcaPage, fixture, true)
    await expect(card(orcaPage, fixture).locator('svg.lucide-server')).toBeVisible()
    await expect(card(orcaPage, fixture).locator('svg.lucide-server-off')).toHaveCount(0)
    await expect(surface(orcaPage, fixture)).not.toHaveClass(/opacity-60/)
    // The copy tracks the verdict, so the two states cannot read the same in any locale.
    const recoveredTooltip = await readHostTooltip(orcaPage, fixture, 'svg.lucide-server')
    expect(recoveredTooltip).toContain(REMOTE_HOST)
    expect(recoveredTooltip).not.toBe(disconnectedTooltip)
    await dismissTooltips(orcaPage)
    await card(orcaPage, fixture).screenshot({
      path: testInfo.outputPath('runtime-host-glyph-recovered.png')
    })
  })
})

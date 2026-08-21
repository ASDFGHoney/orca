import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'

export async function expectFolderWorkspaceSidebarGrouping(
  page: Page,
  testInfo: TestInfo,
  args: { folderPath: string; hostId: `runtime:${string}` }
): Promise<void> {
  const target = await page.evaluate(({ folderPath, hostId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Renderer store unavailable')
    }
    const workspace = store
      .getState()
      .folderWorkspaces.find(
        (candidate) => candidate.folderPath === folderPath && candidate.executionHostId === hostId
      )
    if (!workspace) {
      throw new Error('Runtime folder unavailable for sidebar grouping')
    }
    store.getState().setVisibleWorkspaceHostIds(['local', hostId])
    return { id: workspace.id, name: workspace.name, executionHostId: workspace.executionHostId }
  }, args)
  expect(target.executionHostId).toBe(args.hostId)

  const cases = [
    { id: 'repo', label: 'Project' },
    { id: 'workspace-status', label: 'Status' },
    { id: 'pr-status', label: 'PR' },
    { id: 'none', label: 'None' }
  ] as const
  const identity = `${args.hostId}|folder:${target.id}`
  const placements: { groupBy: string; hostId: string; identity: string }[] = []

  for (const groupBy of cases) {
    await page.evaluate((groupById) => window.__store?.getState().setGroupBy(groupById), groupBy.id)
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().groupBy ?? null))
      .toBe(groupBy.id)
    await expect
      .poll(() =>
        page.evaluate(
          ({ folderPath, hostId }) =>
            window.__store
              ?.getState()
              .folderWorkspaces.some(
                (workspace) =>
                  workspace.folderPath === folderPath && workspace.executionHostId === hostId
              ) ?? false,
          args
        )
      )
      .toBe(true)
    await page.evaluate(
      ({ folderWorkspaceId, hostId }) => {
        window.__store?.getState().revealWorktreeInSidebar(`folder:${folderWorkspaceId}`, {
          behavior: 'auto',
          executionHostId: hostId
        })
      },
      { folderWorkspaceId: target.id, hostId: args.hostId }
    )

    const folderRow = page.locator(`[data-worktree-host-identity="${identity}"]`)
    await expect(folderRow).toBeVisible()
    await expect(folderRow).toContainText(target.name)
    const placement = await page.evaluate((targetIdentity) => {
      const rows = [
        ...document.querySelectorAll<HTMLElement>('[data-worktree-sidebar] [data-index]')
      ].sort(
        (left, right) =>
          Number(left.dataset.index ?? Number.MAX_SAFE_INTEGER) -
          Number(right.dataset.index ?? Number.MAX_SAFE_INTEGER)
      )
      let hostId: string | null = null
      for (const row of rows) {
        const hostHeader = row.querySelector<HTMLElement>('[data-host-header-drag-id]')
        if (hostHeader) {
          hostId = hostHeader.dataset.hostHeaderDragId ?? null
        }
        if (row.dataset.worktreeHostIdentity === targetIdentity) {
          return { hostId, identity: row.dataset.worktreeHostIdentity ?? '' }
        }
      }
      return null
    }, identity)
    expect(placement).toEqual({ hostId: args.hostId, identity })
    placements.push({ groupBy: groupBy.id, ...placement! })
    await page.screenshot({
      path: testInfo.outputPath(`sta-4964-${groupBy.id}.png`),
      fullPage: true
    })
  }

  console.info(`[sta-4964-sidebar] ${JSON.stringify(placements)}`)
}

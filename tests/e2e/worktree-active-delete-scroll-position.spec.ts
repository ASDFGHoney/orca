import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const TARGET_INDEX = 24
const SYNTHETIC_COUNT = 40
const VISUAL_PROOF_PAUSE_MS = 1_200

type RowRemovalFrame = {
  belowTop: number | null
  scrollTop: number
  targetExists: boolean
}

async function pauseForVisualProof(page: Page): Promise<void> {
  if (process.env.ORCA_E2E_RECORD_VIDEO === '1') {
    await page.waitForTimeout(VISUAL_PROOF_PAUSE_MS)
  }
}

async function seedActiveDeletionRows(page: Page): Promise<{
  belowId: string
  successorId: string
  targetId: string
}> {
  return page.evaluate(
    ({ count, targetIndex }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const repo = state.repos[0]
      const source = repo ? state.worktreesByRepo[repo.id]?.[0] : null
      if (!repo || !source) {
        throw new Error('Expected a seeded e2e worktree')
      }

      const now = Date.now()
      const worktrees = Array.from({ length: count }, (_, index) => {
        const suffix = String(index).padStart(2, '0')
        return {
          ...source,
          id: `${repo.id}::active-delete-${suffix}`,
          instanceId: `active-delete-${suffix}`,
          path: source.path,
          displayName: `Active delete row ${suffix}`,
          branch: `active-delete-${suffix}`,
          isMainWorktree: false,
          isPinned: false,
          isUnread: false,
          sortOrder: count - index,
          manualOrder: count - index,
          lastActivityAt: now - index,
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null
        }
      })
      const targetId = worktrees[targetIndex]!.id
      const belowId = worktrees[targetIndex + 1]!.id
      const successorId = worktrees[0]!.id

      store.setState({
        activeRepoId: repo.id,
        activeView: 'terminal',
        activeWorktreeId: targetId,
        activeWorkspaceKey: `worktree:${targetId}`,
        filterRepoIds: [],
        groupBy: 'none',
        hideDefaultBranchWorkspace: false,
        lastVisitedAtByWorktreeId: { [successorId]: now + 1_000 },
        pendingRevealSidebarRow: null,
        pendingRevealWorktree: null,
        repos: state.repos.map((candidate) =>
          candidate.id === repo.id
            ? {
                ...candidate,
                hookSettings: {
                  ...candidate.hookSettings,
                  scripts: { ...candidate.hookSettings?.scripts, setup: 'true' }
                }
              }
            : candidate
        ),
        settings: { ...state.settings, skipDeleteWorktreeConfirm: true },
        setupScriptPromptDismissedRepoIds: [`generation-v1:local\0${repo.id}`],
        showActiveOnly: false,
        showSleepingWorkspaces: true,
        sidebarOpen: true,
        sortBy: 'manual',
        worktreesByRepo: { ...state.worktreesByRepo, [repo.id]: worktrees },
        removeWorktree: async (target) => {
          const id = typeof target === 'string' ? target : target.id
          store.setState((current) => ({
            activeWorktreeId: current.activeWorktreeId === id ? null : current.activeWorktreeId,
            activeWorkspaceKey: current.activeWorktreeId === id ? null : current.activeWorkspaceKey,
            worktreesByRepo: {
              ...current.worktreesByRepo,
              [repo.id]: (current.worktreesByRepo[repo.id] ?? []).filter(
                (worktree) => worktree.id !== id
              )
            }
          }))
          return { ok: true }
        }
      })
      return { belowId, successorId, targetId }
    },
    { count: SYNTHETIC_COUNT, targetIndex: TARGET_INDEX }
  )
}

async function prepareScrolledActiveRow(page: Page, targetId: string): Promise<number> {
  const target = page.locator(
    `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(targetId)}]`
  )
  const scroller = page.locator('[data-worktree-sidebar]')
  await expect
    .poll(async () => {
      if ((await target.count()) > 0) {
        return true
      }
      await scroller.evaluate((element) => {
        element.scrollTop = Math.min(
          element.scrollHeight,
          element.scrollTop + Math.max(100, element.clientHeight / 2)
        )
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
      })
      return false
    })
    .toBe(true)
  await target.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expect(target).toBeVisible()
  await expect(target).toHaveAttribute('aria-current', 'page')
  return scroller.evaluate((element) => element.scrollTop)
}

async function startRowRemovalSampling(
  page: Page,
  targetId: string,
  belowId: string
): Promise<void> {
  await page.evaluate(
    ({ belowId, targetId }) => {
      const sample = async (): Promise<RowRemovalFrame[]> => {
        const frames: RowRemovalFrame[] = []
        for (let index = 0; index < 50; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
          const below = document.querySelector<HTMLElement>(
            `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(belowId)}]`
          )
          frames.push({
            belowTop: below?.getBoundingClientRect().top ?? null,
            scrollTop: scroller?.scrollTop ?? 0,
            targetExists: Boolean(
              document.querySelector(
                `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(targetId)}]`
              )
            )
          })
        }
        return frames
      }
      Reflect.set(window, '__activeDeleteRowRemovalFrames', sample())
    },
    { belowId, targetId }
  )
}

async function finishRowRemovalSampling(page: Page): Promise<RowRemovalFrame[]> {
  return page.evaluate(async () => {
    const pending = Reflect.get(window, '__activeDeleteRowRemovalFrames')
    if (!(pending instanceof Promise)) {
      throw new Error('Row removal sampling was not started')
    }
    return pending
  })
}

test('deleting the active scrolled worktree preserves position and closes the row gap', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1_200, height: 800 })
  const { belowId, successorId, targetId } = await seedActiveDeletionRows(orcaPage)
  const initialScrollTop = await prepareScrolledActiveRow(orcaPage, targetId)
  const target = orcaPage.locator(
    `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(targetId)}]`
  )
  const below = orcaPage.locator(
    `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(belowId)}]`
  )
  await pauseForVisualProof(orcaPage)
  await target.evaluate((element) => {
    const scope = element.querySelector<HTMLElement>(
      '[data-worktree-context-menu-scope="worktree"]'
    )
    if (!scope) {
      throw new Error('Worktree context-menu scope is unavailable')
    }
    scope.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: scope.getBoundingClientRect().left + 10,
        clientY: scope.getBoundingClientRect().top + 10
      })
    )
  })
  const deleteItem = orcaPage.getByRole('menuitem', { name: 'Delete', exact: true })
  await expect(deleteItem).toBeVisible()
  await pauseForVisualProof(orcaPage)
  await startRowRemovalSampling(orcaPage, targetId, belowId)
  await deleteItem.click()

  await expect(target).toHaveCount(0)
  await expect(below).toBeVisible()
  const frames = await finishRowRemovalSampling(orcaPage)
  await pauseForVisualProof(orcaPage)
  const mountedTops = frames.flatMap((frame) => (frame.belowTop === null ? [] : [frame.belowTop]))
  const distinctTops = new Set(mountedTops.map((top) => Math.round(top * 10) / 10))

  expect(distinctTops.size).toBeGreaterThanOrEqual(4)
  expect(Math.max(...mountedTops) - Math.min(...mountedTops)).toBeGreaterThan(30)
  expect(Math.max(...frames.map((frame) => frame.scrollTop))).toBeLessThanOrEqual(
    initialScrollTop + 1
  )
  expect(Math.min(...frames.map((frame) => frame.scrollTop))).toBeGreaterThanOrEqual(
    initialScrollTop - 1
  )
  await expect(
    orcaPage.locator(`[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(successorId)}]`)
  ).toHaveCount(0)
})

test('reduced motion removes the active row without animating its neighbor', async ({
  orcaPage
}) => {
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  await waitForSessionReady(orcaPage)
  const { belowId, targetId } = await seedActiveDeletionRows(orcaPage)
  await prepareScrolledActiveRow(orcaPage, targetId)

  const animationCount = await orcaPage.evaluate(
    async ({ belowId, targetId }) => {
      const store = window.__store!
      const state = store.getState()
      const repoId = state.repos[0]!.id
      store.setState({
        activeWorktreeId: null,
        activeWorkspaceKey: null,
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [repoId]: state.worktreesByRepo[repoId]!.filter((worktree) => worktree.id !== targetId)
        }
      })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const below = document.querySelector<HTMLElement>(
        `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(belowId)}]`
      )
      return (
        below?.closest('[data-worktree-virtual-row]')?.firstElementChild?.getAnimations().length ??
        0
      )
    },
    { belowId, targetId }
  )

  expect(animationCount).toBe(0)
})

/**
 * E2E regression test for issue #6154: when a left/right tab-group split
 * collapses, the surviving terminal must refit to the full width via the
 * deterministic SYNC_FIT_PANES_EVENT dispatched by useRefitOnSplitCollapse —
 * not by waiting on the 150ms-debounced ResizeObserver fallback — so the
 * survivor can never sit pinned at the old narrow column count with a blank
 * right half.
 *
 * The spec needs a real Electron/Chromium: the fit measures an overlay
 * positioned with CSS anchor positioning against a group body that React
 * recreates during the collapse commit, which happy-dom cannot exercise.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import { SYNC_FIT_PANES_EVENT } from '../../src/renderer/src/constants/terminal'

function readSurvivorCols(page: Page, tabId: string): Promise<number> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
    return pane?.terminal?.cols ?? 0
  }, tabId)
}

type CollapseObservation = {
  colsAtCollapseFrame: number
  fitEvents: number
  elapsedMs: number
  frames: number
}

test('surviving terminal refits to full width in the collapse commit frame', async ({
  orcaPage: page
}) => {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)

  const survivorTabId = await page.evaluate(
    (wt) => window.__store?.getState().tabsByWorktree[wt]?.[0]?.id ?? null,
    worktreeId
  )
  if (!survivorTabId) {
    throw new Error('no terminal tab found for the active worktree')
  }

  // Baseline: the lone terminal fit at the full tab-group width.
  let fullCols = 0
  await expect
    .poll(async () => (fullCols = await readSurvivorCols(page, survivorTabId)), {
      timeout: 30_000,
      message: 'survivor terminal never fit at full width'
    })
    .toBeGreaterThan(40)

  // Create a second terminal tab and drop it as a right-hand split group.
  const rightTabId = await page.evaluate((wt) => {
    const state = window.__store
    if (!state) {
      throw new Error('window.__store is not available')
    }
    return state.getState().createTab(wt).id
  }, worktreeId)

  await expect
    .poll(
      () =>
        page.evaluate(
          ({ wt, tabId }) =>
            window.__store
              ?.getState()
              .unifiedTabsByWorktree[wt]?.some((tab) => tab.entityId === tabId) ?? false,
          { wt: worktreeId, tabId: rightTabId }
        ),
      { message: 'created tab never appeared in the unified tab model' }
    )
    .toBe(true)

  await page.evaluate(
    ({ wt, tabId, survivorId }) => {
      const state = window.__store!.getState()
      const unified = state.unifiedTabsByWorktree[wt] ?? []
      const right = unified.find((tab) => tab.entityId === tabId)
      const survivor = unified.find((tab) => tab.entityId === survivorId)
      if (!right || !survivor) {
        throw new Error('unified tab entries missing for split setup')
      }
      state.dropUnifiedTab(right.id, { groupId: survivor.groupId, splitDirection: 'right' })
    },
    { wt: worktreeId, tabId: rightTabId, survivorId: survivorTabId }
  )

  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('[data-tab-group-body-id]').length), {
      message: 'split never committed two tab-group bodies'
    })
    .toBe(2)

  // The survivor must narrow first, otherwise the collapse assertion is vacuous.
  await expect
    .poll(() => readSurvivorCols(page, survivorTabId), {
      timeout: 30_000,
      message: 'survivor terminal never refit to the narrow split width'
    })
    .toBeLessThan(fullCols - 5)

  // Field-faithful setup for #6154: the user's focused agent survives while the
  // *other* group is closed. Focusing the survivor first means the close cannot
  // piggyback on the activation-change fit path — the collapse dispatch is the
  // only thing standing between the survivor and a stale narrow grid.
  await page.evaluate(
    ({ wt, survivorId }) => {
      const state = window.__store!.getState()
      const survivor = (state.unifiedTabsByWorktree[wt] ?? []).find(
        (tab) => tab.entityId === survivorId
      )
      if (!survivor) {
        throw new Error('survivor unified tab missing before collapse')
      }
      state.focusGroup(wt, survivor.groupId)
    },
    { wt: worktreeId, survivorId: survivorTabId }
  )

  // Close the right group's only tab and observe the first frame in which the
  // DOM shows the collapsed (single-body) layout. Everything runs in one
  // evaluate so no Playwright round-trip can straddle the debounce window.
  const collapse = await page.evaluate(
    ({ survivorId, rightId, fitEventName }) =>
      new Promise<CollapseObservation>((resolve, reject) => {
        const readCols = (): number => {
          const manager = window.__paneManagers?.get(survivorId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
          return pane?.terminal?.cols ?? 0
        }
        let fitEvents = 0
        const onFit = (): void => {
          fitEvents += 1
        }
        window.addEventListener(fitEventName, onFit)
        const start = performance.now()
        window.__store!.getState().closeTab(rightId)
        let frames = 0
        const tick = (): void => {
          frames += 1
          const bodies = document.querySelectorAll('[data-tab-group-body-id]').length
          if (bodies === 1) {
            window.removeEventListener(fitEventName, onFit)
            resolve({
              colsAtCollapseFrame: readCols(),
              fitEvents,
              elapsedMs: performance.now() - start,
              frames
            })
            return
          }
          if (frames > 300) {
            window.removeEventListener(fitEventName, onFit)
            reject(new Error(`split never collapsed to one body (still ${bodies})`))
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    { survivorId: survivorTabId, rightId: rightTabId, fitEventName: SYNC_FIT_PANES_EVENT }
  )

  // The collapse commit must dispatch the deterministic sync-fit event; the
  // debounced ResizeObserver fallback never dispatches it, so this fails if
  // useRefitOnSplitCollapse regresses to timer-based refitting.
  expect(collapse.fitEvents, JSON.stringify(collapse)).toBeGreaterThanOrEqual(1)

  // At the first frame that renders the collapsed layout the survivor has
  // already refit to the full width — no window where the old narrow grid
  // paints inside the widened pane (issue #6154's permanent blank half).
  expect(collapse.colsAtCollapseFrame, JSON.stringify(collapse)).toBeGreaterThanOrEqual(
    fullCols - 1
  )

  // User-observable proof: the rendered xterm screen spans the surviving
  // group body instead of leaving the right half blank.
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const body = document.querySelector('[data-tab-group-body-id]')
          const overlay = document.querySelector(`[data-terminal-overlay-tab-id="${id}"]`)
          const screen = overlay?.querySelector('.xterm-screen')
          if (!body || !screen) {
            return 0
          }
          const bodyWidth = body.getBoundingClientRect().width
          return bodyWidth > 0 ? screen.getBoundingClientRect().width / bodyWidth : 0
        }, survivorTabId),
      { message: 'survivor xterm screen never spanned the collapsed group body' }
    )
    .toBeGreaterThan(0.85)
})

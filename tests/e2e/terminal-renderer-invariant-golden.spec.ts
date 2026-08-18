import type { Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

/** Fractional opacity is what makes stacked background layers observable: at
 *  full opacity an extra layer paints the same color as one layer. */
const BACKGROUND_OPACITY = 0.5

/** Sampled inset, in CSS px, from each edge of the xterm surface. Far enough in
 *  to clear a 1px border, close enough to stay inside any padding band. */
const EDGE_INSET = 2

/** Per-channel tolerance. Renderer swaps re-rasterize glyphs, so sample points
 *  avoid text entirely and only need slack for rounding. */
const CHANNEL_TOLERANCE = 2

type Rgb = { r: number; g: number; b: number }

type SurfaceSample = {
  top: Rgb
  right: Rgb
  bottom: Rgb
  left: Rgb
}

async function setGpuAcceleration(page: Page, mode: 'on' | 'off'): Promise<void> {
  await page.evaluate((gpuMode) => {
    const store = window.__store
    const state = store?.getState()
    if (!store || !state?.settings) {
      throw new Error('Store unavailable')
    }
    store.setState({ settings: { ...state.settings, terminalGpuAcceleration: gpuMode } })
    const worktreeId = state.activeWorktreeId
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    manager?.setTerminalGpuAcceleration(gpuMode)
  }, mode)

  await page.waitForFunction(
    (expectWebgl) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const diagnostics = tabId
        ? (window.__paneManagers?.get(tabId)?.getRenderingDiagnostics?.() ?? [])
        : []
      if (diagnostics.length === 0) {
        return false
      }
      return diagnostics.some((diagnostic) => Boolean(diagnostic.hasWebgl) === expectWebgl)
    },
    mode === 'on',
    { timeout: 15_000 }
  )
}

/** Read the painted color just inside each edge of the xterm surface. Reads the
 *  rasterized page rather than computed style: the defect this guards against is
 *  an extra composited layer, which every layer's own computed style reports as
 *  correct. */
async function sampleSurfaceEdges(page: Page): Promise<SurfaceSample> {
  const surface = page.locator('.xterm-container .xterm').first()
  await expect(surface).toBeVisible({ timeout: 15_000 })
  const box = await surface.boundingBox()
  if (!box) {
    throw new Error('xterm surface has no layout box')
  }

  // Why not page.viewportSize(): it is null under Electron, which has no
  // browser-set viewport. Derive the raster scale from the page itself.
  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))

  const image = PNG.sync.read(Buffer.from(await page.screenshot()))
  const scaleX = image.width / layout.width
  const scaleY = image.height / layout.height

  const readAt = (cssX: number, cssY: number): Rgb => {
    const x = Math.min(image.width - 1, Math.max(0, Math.round(cssX * scaleX)))
    const y = Math.min(image.height - 1, Math.max(0, Math.round(cssY * scaleY)))
    const offset = (y * image.width + x) * 4
    return { r: image.data[offset], g: image.data[offset + 1], b: image.data[offset + 2] }
  }

  const midX = box.x + box.width / 2
  const midY = box.y + box.height / 2
  return {
    top: readAt(midX, box.y + EDGE_INSET),
    right: readAt(box.x + box.width - EDGE_INSET, midY),
    bottom: readAt(midX, box.y + box.height - EDGE_INSET),
    left: readAt(box.x + EDGE_INSET, midY)
  }
}

function formatRgb(color: Rgb): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

test.describe('terminal renderer invariance', () => {
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
  })

  // Why this invariant: GPU acceleration is a performance setting. If turning it
  // on changes the pixels a user sees, some paint is conditioned on the renderer
  // — which is how #14583 shipped a black bar that only appeared in packaged
  // builds. It scoped a background ring to [data-terminal-renderer='webgl'], so
  // the padding band composited one extra translucent layer under WebGL and none
  // under the DOM renderer. Unit tests could not see it (the defect lives in the
  // built CSS cascade) and dev-mode QA did not reproduce it.
  test('terminal surface paints identically with and without GPU acceleration @terminal-rendering-golden', async ({
    orcaPage
  }) => {
    await orcaPage.evaluate((opacity) => {
      const store = window.__store
      const state = store?.getState()
      if (!store || !state?.settings) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings: { ...state.settings, terminalBackgroundOpacity: opacity } })
    }, BACKGROUND_OPACITY)

    await setGpuAcceleration(orcaPage, 'off')
    const domRenderer = await sampleSurfaceEdges(orcaPage)

    await setGpuAcceleration(orcaPage, 'on')
    const webglRenderer = await sampleSurfaceEdges(orcaPage)

    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      const dom = domRenderer[edge]
      const webgl = webglRenderer[edge]
      const delta = Math.max(
        Math.abs(dom.r - webgl.r),
        Math.abs(dom.g - webgl.g),
        Math.abs(dom.b - webgl.b)
      )
      expect(
        delta,
        `${edge} edge differs between renderers: DOM ${formatRgb(dom)} vs WebGL ${formatRgb(webgl)}. ` +
          'A background layer is conditioned on the active renderer.'
      ).toBeLessThanOrEqual(CHANNEL_TOLERANCE)
    }
  })
})

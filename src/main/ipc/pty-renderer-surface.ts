import type { BrowserWindow, WebContents } from 'electron'

/**
 * The renderer surface the PTY handlers talk to, which may not exist.
 *
 * Why: `orca serve` — and a future Node-only backend — run the same PTY handlers
 * with no window. That used to be faked: `registerHeadlessPtyRuntime` built a
 * `BrowserWindow` whose `isDestroyed()` returned true and whose `webContents.send`
 * was a no-op, purely to satisfy the type — the "looks fine, silently lies" shape
 * this codebase rejects elsewhere, and what forced an `electron` value import into a
 * path that needs none. It now passes `null`.
 *
 * An absent renderer is semantically identical to a destroyed one — every call site
 * already guards on `isDestroyed()` and skips — so model it as `null` and say so.
 */

/**
 * True when there is no renderer, or it is gone. Callers already treat these the same.
 *
 * Why webContents is checked separately (STA-2373, re-broken by #15927 as STA-5373): a
 * window can be alive while its webContents is already destroyed — teardown, a renderer
 * crash, a reload in flight. `webContents.send()` then THROWS, and the daemon-death
 * fan-out that calls it is not inside a try/catch, so an uncaught throw in the main
 * process kills the whole app and every terminal with it.
 *
 * Why the typeof guard: preserved from the original fix — a stubbed or partially torn
 * down webContents may not expose the method, and this must never be the thing that
 * throws.
 */
export function isRendererGone(window: BrowserWindow | null): boolean {
  if (window === null || window.isDestroyed()) {
    return true
  }
  const contents = window.webContents as WebContents | undefined
  return !contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())
}

/** Send to the renderer if one is listening. Absent renderer drops the message, as a destroyed one does. */
export function sendToRenderer(
  window: BrowserWindow | null,
  channel: string,
  payload?: unknown
): void {
  if (isRendererGone(window)) {
    return
  }
  window!.webContents.send(channel, payload)
}

/** The renderer's WebContents, or null. Used for identity checks and listener registration. */
export function rendererWebContents(window: BrowserWindow | null): WebContents | null {
  return isRendererGone(window) ? null : window!.webContents
}

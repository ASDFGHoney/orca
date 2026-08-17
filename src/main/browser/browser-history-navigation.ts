const HISTORY_NAVIGATION_SETTLE_TIMEOUT_MS = 10_000

type BrowserHistoryDirection = 'back' | 'forward'

export async function waitForBrowserHistoryNavigation(
  webContents: Electron.WebContents,
  direction: BrowserHistoryDirection
): Promise<void> {
  const history = webContents.navigationHistory
  const canNavigate = direction === 'back' ? history.canGoBack() : history.canGoForward()
  if (!canNavigate) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      webContents.removeListener('did-navigate', finish)
      webContents.removeListener('did-navigate-in-page', finish)
      webContents.removeListener('did-fail-load', finish)
      webContents.removeListener('destroyed', finish)
      if (fallbackTimer) {
        clearTimeout(fallbackTimer)
      }
    }
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }

    webContents.on('did-navigate', finish)
    webContents.on('did-navigate-in-page', finish)
    webContents.on('did-fail-load', finish)
    webContents.on('destroyed', finish)
    fallbackTimer = setTimeout(finish, HISTORY_NAVIGATION_SETTLE_TIMEOUT_MS)
    fallbackTimer.unref?.()
    try {
      if (direction === 'back') {
        history.goBack()
      } else {
        history.goForward()
      }
    } catch (error) {
      if (!settled) {
        settled = true
        cleanup()
        reject(error)
      }
    }
  })
}

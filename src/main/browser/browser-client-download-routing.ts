import type { BrowserClientDownloadRoute } from './browser-client-download-relay'

export type BrowserClientDownloadRouter = {
  route(input: { guestWebContentsId: number }): BrowserClientDownloadRoute | null
}

let activeRouter: BrowserClientDownloadRouter | null = null

export function setBrowserClientDownloadRouter(router: BrowserClientDownloadRouter | null): void {
  activeRouter = router
}

// Why: with no client-hosted router the download keeps its current desktop Downloads behavior, which
// is also the mixed-version fallback when the host never negotiated the file channel.
export function routeBrowserClientDownload(input: {
  guestWebContentsId: number
}): BrowserClientDownloadRoute | null {
  try {
    return activeRouter?.route(input) ?? null
  } catch {
    return null
  }
}

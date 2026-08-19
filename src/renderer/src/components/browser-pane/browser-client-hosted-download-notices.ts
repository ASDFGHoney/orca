import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadRequestedEvent
} from '../../../../shared/browser-guest-events'
import { formatBrowserRemoteDownloadMessage } from './browser-download-destination-toast'

/** One toast per download, so progress, completion and failure replace each other in place. */
function downloadToastId(downloadId: string): string {
  return `browser-download:${downloadId}`
}

/**
 * A client-hosted page has no download shelf and its bytes never land in this desktop's Downloads
 * folder, so these toasts are the only signal that a download started, landed on the remote
 * workspace, or was refused.
 */
export function useBrowserClientHostedDownloadNotices(browserPageId: string): void {
  const filenamesRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    const filenames = filenamesRef.current
    const releaseRequested = window.api.browser.onDownloadRequested(
      (event: BrowserDownloadRequestedEvent) => {
        if (event.browserPageId !== browserPageId) {
          return
        }
        filenames.set(event.downloadId, event.filename)
        toast.loading(
          translate('browser.clientHosted.download.started', 'Downloading {{filename}}…', {
            filename: event.filename
          }),
          { id: downloadToastId(event.downloadId) }
        )
      }
    )
    const releaseFinished = window.api.browser.onDownloadFinished(
      (event: BrowserDownloadFinishedEvent) => {
        if (event.browserPageId !== browserPageId) {
          return
        }
        const filename = filenames.get(event.downloadId) ?? ''
        filenames.delete(event.downloadId)
        emitBrowserClientHostedDownloadNotice(event, filename)
      }
    )
    return () => {
      releaseRequested()
      releaseFinished()
      filenames.clear()
    }
  }, [browserPageId])
}

export function emitBrowserClientHostedDownloadNotice(
  event: BrowserDownloadFinishedEvent,
  filename: string
): void {
  const id = downloadToastId(event.downloadId)
  if (event.status === 'completed') {
    toast.success(
      event.remoteDestination
        ? formatBrowserRemoteDownloadMessage(event.remoteDestination)
        : translate('browser.clientHosted.download.completed', 'Downloaded {{filename}}', {
            filename
          }),
      { id }
    )
    return
  }
  toast.error(
    event.error ||
      (event.status === 'canceled'
        ? translate('browser.clientHosted.download.canceled', 'Download canceled.')
        : translate('browser.clientHosted.download.failed', "Couldn't finish the download.")),
    { id }
  )
}

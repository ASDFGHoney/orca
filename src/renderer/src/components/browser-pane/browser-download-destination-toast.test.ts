import { describe, expect, it, vi } from 'vitest'

import type { BrowserDownloadFinishedEvent } from '../../../../shared/browser-guest-events'
import {
  emitBrowserRemoteDownloadToast,
  formatBrowserRemoteDownloadMessage
} from './browser-download-destination-toast'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => values[name] ?? '')
}))

function finished(overrides: Partial<BrowserDownloadFinishedEvent>): BrowserDownloadFinishedEvent {
  return {
    downloadId: 'download-1',
    status: 'completed',
    savePath: null,
    error: null,
    ...overrides
  }
}

describe('browser remote download toast', () => {
  it('names the file, the remote path, and the execution host', () => {
    expect(
      formatBrowserRemoteDownloadMessage({
        workspaceRelativePath: '.orca/browser-downloads/report.pdf',
        hostLabel: 'build-box'
      })
    ).toBe('report.pdf saved to .orca/browser-downloads/report.pdf on build-box')
  })

  it('stays silent for a download that saved on this device', () => {
    expect(emitBrowserRemoteDownloadToast(finished({ savePath: '/home/me/Downloads/a.pdf' }))).toBe(
      false
    )
  })

  it('stays silent for a failed remote download', () => {
    expect(
      emitBrowserRemoteDownloadToast(
        finished({
          status: 'failed',
          error: 'Download failed.',
          remoteDestination: { workspaceRelativePath: 'a', hostLabel: 'b' }
        })
      )
    ).toBe(false)
  })

  it('announces a completed remote download', () => {
    expect(
      emitBrowserRemoteDownloadToast(
        finished({
          remoteDestination: {
            workspaceRelativePath: '.orca/browser-downloads/report.pdf',
            hostLabel: 'build-box'
          }
        })
      )
    ).toBe(true)
  })
})

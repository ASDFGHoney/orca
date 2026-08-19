// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn()
}))

vi.mock('sonner', () => ({ toast: toastMocks }))

import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadRequestedEvent
} from '../../../../shared/browser-guest-events'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

type Listeners = {
  requested: ((event: BrowserDownloadRequestedEvent) => void)[]
  finished: ((event: BrowserDownloadFinishedEvent) => void)[]
}

const listeners: Listeners = { requested: [], finished: [] }

beforeEach(() => {
  listeners.requested = []
  listeners.finished = []
  // Only the preload boundary is faked: the pane subscribes through the real window.api surface.
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        onDownloadRequested: (callback: (event: BrowserDownloadRequestedEvent) => void) => {
          listeners.requested.push(callback)
          return () => {
            listeners.requested = listeners.requested.filter((entry) => entry !== callback)
          }
        },
        onDownloadFinished: (callback: (event: BrowserDownloadFinishedEvent) => void) => {
          listeners.finished.push(callback)
          return () => {
            listeners.finished = listeners.finished.filter((entry) => entry !== callback)
          }
        }
      },
      runtimeEnvironments: { call: vi.fn(async () => ({})) }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPane(browserPageId = 'page-a'): void {
  render(
    <ClientHostedBrowserPagePane
      browserTab={
        {
          id: browserPageId,
          url: 'https://example.internal/reports',
          title: 'Reports',
          loading: false,
          canGoBack: false,
          canGoForward: false
        } as never
      }
      runtimeEnvironmentId="environment-a"
      worktreeId="worktree-a"
      placement={{
        kind: 'client',
        browserHostClientId: 'client-a',
        browserHostGeneration: 3,
        pageHostGeneration: 7
      }}
      isActive
      onUpdatePageState={vi.fn()}
      onSetUrl={vi.fn()}
    />
  )
}

function emitRequested(overrides: Partial<BrowserDownloadRequestedEvent> = {}): void {
  const event = {
    browserPageId: 'page-a',
    downloadId: 'download-1',
    origin: 'https://example.internal',
    filename: 'report.pdf',
    totalBytes: 1024,
    mimeType: 'application/pdf',
    savePath: '/tmp/staging/download',
    status: 'downloading',
    ...overrides
  } as BrowserDownloadRequestedEvent
  act(() => {
    for (const listener of listeners.requested) {
      listener(event)
    }
  })
}

function emitFinished(overrides: Partial<BrowserDownloadFinishedEvent> = {}): void {
  const event = {
    browserPageId: 'page-a',
    downloadId: 'download-1',
    status: 'completed',
    savePath: null,
    error: null,
    ...overrides
  } as BrowserDownloadFinishedEvent
  act(() => {
    for (const listener of listeners.finished) {
      listener(event)
    }
  })
}

describe('ClientHostedBrowserPagePane download notices', () => {
  it('subscribes to the download lifecycle for the page it renders', () => {
    renderPane()

    expect(listeners.requested).toHaveLength(1)
    expect(listeners.finished).toHaveLength(1)
  })

  it('names the remote workspace destination when the download lands there', () => {
    renderPane()

    emitRequested()
    expect(toastMocks.loading).toHaveBeenCalledWith('Downloading report.pdf…', {
      id: 'browser-download:download-1'
    })

    emitFinished({
      remoteDestination: {
        workspaceRelativePath: '.orca/browser-downloads/report.pdf',
        hostLabel: 'build-box'
      }
    })

    expect(toastMocks.success).toHaveBeenCalledWith(
      'Saved to .orca/browser-downloads/report.pdf on build-box',
      { id: 'browser-download:download-1' }
    )
  })

  it('surfaces the fail-closed remote error instead of dropping it', () => {
    renderPane()
    emitRequested()

    emitFinished({
      status: 'failed',
      error: 'Could not save the download to the remote workspace.'
    })

    expect(toastMocks.error).toHaveBeenCalledWith(
      'Could not save the download to the remote workspace.',
      { id: 'browser-download:download-1' }
    )
  })

  it('reports a canceled download rather than leaving the spinner running', () => {
    renderPane()
    emitRequested()

    emitFinished({ status: 'canceled' })

    expect(toastMocks.error).toHaveBeenCalledWith('Download canceled.', {
      id: 'browser-download:download-1'
    })
  })

  it('ignores downloads belonging to another page', () => {
    renderPane('page-a')

    emitRequested({ browserPageId: 'page-b', downloadId: 'download-2' })
    emitFinished({ browserPageId: 'page-b', downloadId: 'download-2' })

    expect(toastMocks.loading).not.toHaveBeenCalled()
    expect(toastMocks.success).not.toHaveBeenCalled()
  })
})

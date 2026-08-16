// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  call: vi.fn()
}))

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))

vi.mock('./BrowserAddressBar', () => ({
  default: ({ value }: { value: string }) => <input aria-label="Address" value={value} readOnly />
}))

import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

describe('ClientHostedBrowserPagePane', () => {
  beforeEach(() => {
    mocks.attach.mockReset()
    mocks.call.mockReset().mockResolvedValue({ ok: true, result: { accepted: true } })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: mocks.call } }
    })
  })
  afterEach(() => cleanup())

  it('attaches the exact retained guest once and keeps focus changes local', () => {
    const { webview, focus } = createWebview()
    const detach = vi.fn()
    mocks.attach.mockReturnValue(retainedAttachment(webview, detach))
    const onUpdatePageState = vi.fn()
    const onSetUrl = vi.fn()
    const view = render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        runtimeEnvironmentId="environment-a"
        placement={PLACEMENT}
        isActive={false}
        onUpdatePageState={onUpdatePageState}
        onSetUrl={onSetUrl}
      />
    )

    expect(mocks.attach).toHaveBeenCalledTimes(1)
    expect(mocks.attach).toHaveBeenCalledWith(
      { browserPageId: 'page-a', pageHostGeneration: 7 },
      expect.any(HTMLElement)
    )
    view.rerender(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        runtimeEnvironmentId="environment-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={onUpdatePageState}
        onSetUrl={onSetUrl}
      />
    )

    expect(mocks.attach).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('updates local chrome from guest navigation without remote stream work', () => {
    const { webview, setUrl, setTitle } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    const onUpdatePageState = vi.fn()
    const onSetUrl = vi.fn()
    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        runtimeEnvironmentId="environment-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={onUpdatePageState}
        onSetUrl={onSetUrl}
      />
    )
    onUpdatePageState.mockClear()
    onSetUrl.mockClear()
    setUrl('https://remote.internal/path')
    setTitle('Remote page')

    act(() => webview.dispatchEvent(new Event('did-navigate')))

    expect(onSetUrl).toHaveBeenCalledWith('page-a', 'https://remote.internal/path', {
      preserveLoadError: true
    })
    expect(onUpdatePageState).toHaveBeenCalledWith(
      'page-a',
      expect.objectContaining({
        title: 'Remote page',
        loading: false,
        canGoBack: true,
        canGoForward: false
      })
    )
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe(
      'https://remote.internal/path'
    )
  })

  it('shows exact-generation unavailability without creating a fallback guest', () => {
    mocks.attach.mockReturnValue(null)

    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        runtimeEnvironmentId="environment-a"
        placement={{ ...PLACEMENT, pageHostGeneration: 8 }}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )

    expect(mocks.attach).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Client-hosted browser unavailable')).not.toBeNull()
    expect(document.querySelector('webview')).toBeNull()
  })

  it('publishes full guest metadata through the exact runtime placement', async () => {
    const { webview, setUrl, setTitle } = createWebview()
    mocks.attach.mockReturnValue(retainedAttachment(webview))
    render(
      <ClientHostedBrowserPagePane
        browserTab={page()}
        runtimeEnvironmentId="environment-a"
        placement={PLACEMENT}
        isActive
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    )
    setUrl('https://remote.internal/path')
    setTitle('Remote page')

    act(() => webview.dispatchEvent(new Event('did-navigate')))

    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call).toHaveBeenLastCalledWith({
      selector: 'environment-a',
      method: 'browser.clientHost.pageMetadata',
      params: {
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        browserPageId: 'page-a',
        pageHostGeneration: 7,
        revision: 2,
        url: 'https://remote.internal/path',
        title: 'Remote page',
        loading: false,
        canGoBack: true,
        canGoForward: false
      }
    })
  })
})

function page(): BrowserPage {
  return {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'about:blank',
    title: 'New Tab',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function createWebview(): {
  webview: Electron.WebviewTag
  focus: ReturnType<typeof vi.fn>
  setUrl(url: string): void
  setTitle(title: string): void
} {
  const webview = document.createElement('webview') as Electron.WebviewTag
  let url = 'about:blank'
  let title = 'New Tab'
  const focus = vi.fn()
  Object.assign(webview, {
    getURL: vi.fn(() => url),
    getTitle: vi.fn(() => title),
    isLoading: vi.fn(() => false),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => false),
    focus,
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    loadURL: vi.fn(async () => {})
  })
  return {
    webview,
    focus,
    setUrl: (nextUrl) => {
      url = nextUrl
    },
    setTitle: (nextTitle) => {
      title = nextTitle
    }
  }
}

function retainedAttachment(webview: Electron.WebviewTag, detach = vi.fn()) {
  let revision = 0
  return {
    webview,
    detach,
    nextMetadataRevision: vi.fn(() => ++revision)
  }
}

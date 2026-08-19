// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn()
}))

vi.mock('sonner', () => ({ toast: toastMocks }))

import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

type PopupEvent = {
  browserPageId: string
  origin: string
  action: 'opened-in-orca' | 'opened-external' | 'blocked'
}

let popupListeners: ((event: PopupEvent) => void)[] = []

beforeEach(() => {
  popupListeners = []
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        onDownloadRequested: () => () => {},
        onDownloadFinished: () => () => {},
        onPopup: (callback: (event: PopupEvent) => void) => {
          popupListeners.push(callback)
          return () => {
            popupListeners = popupListeners.filter((entry) => entry !== callback)
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

function renderPane(): void {
  render(
    <ClientHostedBrowserPagePane
      browserTab={
        {
          id: 'page-a',
          url: 'https://example.internal/app',
          title: 'App',
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

function emitPopup(overrides: Partial<PopupEvent> = {}): void {
  const event: PopupEvent = {
    browserPageId: 'page-a',
    origin: 'https://accounts.example.com',
    action: 'blocked',
    ...overrides
  }
  act(() => {
    for (const listener of popupListeners) {
      listener(event)
    }
  })
}

describe('ClientHostedBrowserPagePane popup notices', () => {
  it('names the origin whose popup was refused', () => {
    renderPane()

    emitPopup()

    expect(toastMocks.message).toHaveBeenCalledWith('Popup blocked: https://accounts.example.com', {
      id: 'browser-popup-blocked:page-a:https://accounts.example.com'
    })
  })

  it('collapses a retrying site onto one notice per origin', () => {
    renderPane()

    emitPopup()
    emitPopup()
    emitPopup()

    expect(toastMocks.message).toHaveBeenCalledTimes(3)
    const ids = toastMocks.message.mock.calls.map((call) => (call[1] as { id: string }).id)
    expect(new Set(ids).size).toBe(1)
  })

  it('stays silent for popups Orca actually opened', () => {
    renderPane()

    emitPopup({ action: 'opened-in-orca' })
    emitPopup({ action: 'opened-external' })
    emitPopup({ browserPageId: 'page-b' })

    expect(toastMocks.message).not.toHaveBeenCalled()
  })
})

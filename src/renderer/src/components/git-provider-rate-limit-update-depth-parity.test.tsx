// @vitest-environment happy-dom

/**
 * Provider parity: both rate-limit hooks must escalate React #185 rather than paint it as a
 * provider outage. A GitHub-only guard would leave GitLab users unprotected.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitHubRateLimitSnapshot } from './github/github-rate-limit-display'
import { useGitLabRateLimitSnapshot } from './gitlab/gitlab-rate-limit-display'
import { clearReactErrorBoundaryReportingForTest } from '@/lib/react-error-boundary-reporting'
import {
  flushReactUpdateDepthEscalationsForTest,
  resetReactUpdateDepthEscalationForTest
} from '@/lib/react-update-depth-escalation'

const REACT_185 =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message.'

const mockStoreState = {
  settings: {},
  activeView: 'settings',
  activeModal: 'settings',
  activeTabType: null,
  rightSidebarTab: null,
  activeWorktreeId: null
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mockStoreState), {
    getState: () => mockStoreState
  })
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  callRuntimeRpc: vi.fn()
}))

const recordRendererError = vi.fn()
const ghRateLimit = vi.fn()
const glRateLimit = vi.fn()
const roots: Root[] = []

type HookResult = { hasError: boolean }

function renderHook(useHook: () => HookResult): { current: HookResult | null } {
  const ref: { current: HookResult | null } = { current: null }
  function Probe(): null {
    ref.current = useHook()
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<Probe />)
  })
  return ref
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  recordRendererError.mockReset()
  recordRendererError.mockResolvedValue({ ok: true, report: null, deduped: false })
  ghRateLimit.mockReset().mockRejectedValue(new Error(REACT_185))
  glRateLimit.mockReset().mockRejectedValue(new Error(REACT_185))
  resetReactUpdateDepthEscalationForTest()
  clearReactErrorBoundaryReportingForTest()
  Object.assign(globalThis.window, {
    api: {
      gh: { rateLimit: ghRateLimit },
      gl: { rateLimit: glRateLimit },
      crashReports: { recordRendererError }
    }
  })
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
})

describe.each([
  ['github', () => useGitHubRateLimitSnapshot({ autoRefresh: false })],
  ['gitlab', () => useGitLabRateLimitSnapshot({ autoRefresh: false })]
])('%s rate limit refresh', (provider, useHook) => {
  it('escalates React #185 instead of reporting a provider error', async () => {
    const hook = renderHook(useHook as () => HookResult)

    await act(async () => {
      await (hook.current as unknown as { refresh: () => Promise<void> }).refresh()
    })
    await flushReactUpdateDepthEscalationsForTest()

    expect(hook.current?.hasError).toBe(false)
    expect(recordRendererError).toHaveBeenCalledTimes(1)
    expect(recordRendererError.mock.calls[0]?.[0]?.boundaryId).toContain(
      `${provider}-rate-limit-display.refreshSnapshot`
    )
    expect(recordRendererError.mock.calls[0]?.[0]?.attribution).toBe('unreliable')
  })

  it('still reports an ordinary provider failure', async () => {
    ghRateLimit.mockRejectedValue(new Error('gh: HTTP 503'))
    glRateLimit.mockRejectedValue(new Error('glab: HTTP 503'))
    const hook = renderHook(useHook as () => HookResult)

    await act(async () => {
      await (hook.current as unknown as { refresh: () => Promise<void> }).refresh()
    })

    expect(hook.current?.hasError).toBe(true)
    expect(recordRendererError).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildReactErrorBoundaryReportArgs,
  clearReactErrorBoundaryReportingForTest,
  reportReactErrorBoundaryCrash
} from './react-error-boundary-reporting'
import { RENDERER_ERROR_DEDUPE_MS, type CrashReportRecord } from '../../../shared/crash-reporting'

const mocks = vi.hoisted(() => ({
  recordRendererError: vi.fn(),
  dispatchEvent: vi.fn(),
  state: {
    activeView: 'terminal',
    activeModal: 'none',
    activeTabType: 'editor',
    rightSidebarTab: 'source-control',
    activeWorktreeId: 'repo-1::/Users/alice/project'
  }
}))

function makeReport(id: string): CrashReportRecord {
  return {
    id,
    createdAt: '2026-05-30T20:00:00.000Z',
    status: 'pending',
    source: 'renderer',
    processType: 'react-render',
    reason: 'react-error-boundary',
    exitCode: null,
    appVersion: '1.0.0',
    platform: 'darwin',
    osRelease: '25.0.0',
    arch: 'arm64',
    electronVersion: '41.0.0',
    chromeVersion: '141.0.0',
    details: { surface: 'page' }
  }
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

beforeEach(() => {
  clearReactErrorBoundaryReportingForTest()
  mocks.recordRendererError.mockReset()
  mocks.dispatchEvent.mockReset()
  mocks.recordRendererError.mockResolvedValue({
    ok: true,
    report: makeReport('react-report-1'),
    deduped: false
  })
  vi.stubGlobal('window', {
    dispatchEvent: mocks.dispatchEvent,
    api: {
      crashReports: {
        recordRendererError: mocks.recordRendererError
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('react error boundary reporting', () => {
  it('builds a renderer error payload with low-cardinality app context', () => {
    const args = buildReactErrorBoundaryReportArgs({
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      error: new TypeError('Cannot render /Users/alice/project'),
      errorInfo: { componentStack: 'at Terminal\nat App' },
      context: {
        activeView: 'terminal',
        activeModal: 'none',
        activeTabType: 'editor',
        activeRightSidebarTab: 'source-control',
        hasActiveWorktree: true
      }
    })

    expect(args).toMatchObject({
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      errorName: 'TypeError',
      errorMessage: 'Cannot render /Users/alice/project',
      componentStack: 'at Terminal\nat App',
      activeView: 'terminal',
      activeModal: 'none',
      activeTabType: 'editor',
      activeRightSidebarTab: 'source-control',
      hasActiveWorktree: true
    })
  })

  it('derives #185 attribution from the error itself, without boundary opt-in', async () => {
    await reportReactErrorBoundaryCrash({
      boundaryId: 'page.settings',
      surface: 'page',
      error: new Error('Minified React error #185; visit https://react.dev/errors/185')
    })

    expect(mocks.recordRendererError).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: 'unreliable' })
    )
  })

  it('omits attribution for ordinary render errors', () => {
    const args = buildReactErrorBoundaryReportArgs({
      boundaryId: 'page.settings',
      surface: 'page',
      error: new Error('render failed')
    })

    expect(args).not.toHaveProperty('attribution')
  })

  it('reports a caught render error once per boundary signature', async () => {
    const error = new Error('render failed')
    await reportReactErrorBoundaryCrash({
      boundaryId: 'page.settings',
      surface: 'page',
      error,
      errorInfo: { componentStack: 'at Settings\nat App' }
    })
    await reportReactErrorBoundaryCrash({
      boundaryId: 'page.settings',
      surface: 'page',
      error,
      errorInfo: { componentStack: 'at Settings\nat App' }
    })

    expect(mocks.recordRendererError).toHaveBeenCalledTimes(1)
    expect(mocks.dispatchEvent).toHaveBeenCalledTimes(1)
    expect(mocks.recordRendererError).toHaveBeenCalledWith(
      expect.objectContaining({
        boundaryId: 'page.settings',
        surface: 'page',
        activeView: 'terminal',
        activeModal: 'none',
        activeTabType: 'editor',
        activeRightSidebarTab: 'source-control',
        hasActiveWorktree: true
      })
    )
  })

  it('re-reports an identical signature once the main-process dedupe window elapses', async () => {
    vi.useFakeTimers()
    try {
      const report = () =>
        reportReactErrorBoundaryCrash({
          boundaryId: 'page.settings',
          surface: 'page',
          error: new Error('render failed'),
          repeatAfterDedupeWindow: true
        })
      await report()
      vi.setSystemTime(Date.now() + RENDERER_ERROR_DEDUPE_MS - 1)
      await report()
      expect(mocks.recordRendererError).toHaveBeenCalledTimes(1)

      // Past the window the main process accepts the report again, so the renderer must not withhold it:
      // its key set only evicts after 50 *distinct* other errors, which one recurring crash never produces.
      vi.setSystemTime(Date.now() + 1)
      await report()
      expect(mocks.recordRendererError).toHaveBeenCalledTimes(2)
      expect(mocks.dispatchEvent).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mounted boundary at one report per session so the crash dialog cannot re-open', async () => {
    vi.useFakeTimers()
    try {
      // CrashReportDialog opens the modal for every non-deduped report, with no per-launch guard on
      // that path; a resetKey-driven boundary re-catches the same signature indefinitely.
      const report = () =>
        reportReactErrorBoundaryCrash({
          boundaryId: 'modal.quick-open',
          surface: 'modal',
          error: new Error('render failed')
        })
      await report()
      for (let hour = 0; hour < 3; hour++) {
        for (let tick = 0; tick < 6; tick++) {
          vi.setSystemTime(Date.now() + RENDERER_ERROR_DEDUPE_MS)
          await report()
        }
      }

      expect(mocks.recordRendererError).toHaveBeenCalledTimes(1)
      expect(mocks.dispatchEvent).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

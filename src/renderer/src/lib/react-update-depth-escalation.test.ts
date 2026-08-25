// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  escalateReactUpdateDepthError,
  flushReactUpdateDepthEscalationsForTest,
  resetReactUpdateDepthEscalationForTest
} from './react-update-depth-escalation'
import {
  clearReactErrorBoundaryReportingForTest,
  REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT
} from './react-error-boundary-reporting'

const REACT_185_MINIFIED =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'
const REACT_185_LEGACY =
  'Minified React error #185; visit https://reactjs.org/docs/error-decoder.html?invariant=185 for the full message.'
const REACT_185_DEV =
  'Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate.'

const recordRendererError = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeView: 'settings',
      activeModal: 'settings',
      activeTabType: null,
      rightSidebarTab: null,
      activeWorktreeId: null
    })
  }
}))

const SITE = 'settings.ReleaseChannelSection.loadBuilds'

let captured: ErrorEvent[] = []

function captureHostError(event: Event): void {
  captured.push(event as ErrorEvent)
}

beforeEach(() => {
  captured = []
  recordRendererError.mockReset()
  recordRendererError.mockResolvedValue({ ok: true, report: null, deduped: false })
  resetReactUpdateDepthEscalationForTest()
  clearReactErrorBoundaryReportingForTest()
  window.api = {
    crashReports: { recordRendererError }
  } as unknown as typeof window.api
  window.addEventListener('error', captureHostError)
})

afterEach(() => {
  window.removeEventListener('error', captureHostError)
})

describe('react update depth escalation', () => {
  it('leaves ordinary errors to the catching site', () => {
    expect(escalateReactUpdateDepthError(new TypeError('fetch failed'), SITE)).toBe(false)
    expect(escalateReactUpdateDepthError('HTTP 500: rate limited', SITE)).toBe(false)
    expect(escalateReactUpdateDepthError(null, SITE)).toBe(false)
    expect(recordRendererError).not.toHaveBeenCalled()
    expect(captured).toHaveLength(0)
  })

  it.each([
    ['minified production digest', REACT_185_MINIFIED],
    ['legacy invariant digest', REACT_185_LEGACY],
    ['development message', REACT_185_DEV]
  ])('escalates the %s', async (_label, message) => {
    expect(escalateReactUpdateDepthError(new Error(message), SITE)).toBe(true)
    await flushReactUpdateDepthEscalationsForTest()
    expect(recordRendererError).toHaveBeenCalledTimes(1)
    expect(recordRendererError.mock.calls[0]?.[0]).toMatchObject({
      errorMessage: message,
      attribution: 'unreliable'
    })
    // The catching site is the only attribution #185 has; any boundary that caught it names a bystander.
    expect(recordRendererError.mock.calls[0]?.[0]?.boundaryId).toContain(
      'settings.ReleaseChannelSection.loadBuilds'
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]?.error).toBeInstanceOf(Error)
  })

  it('does not match neighbouring React error numbers', () => {
    for (const digest of ['#1850', '#1852', '#18', '#310']) {
      expect(
        escalateReactUpdateDepthError(
          new Error(`Minified React error ${digest}; visit https://react.dev/errors/x`),
          SITE
        )
      ).toBe(false)
    }
    expect(recordRendererError).not.toHaveBeenCalled()
  })

  it('reports a runaway site once, so the loop cannot flood the crash reporter', async () => {
    for (let i = 0; i < 200; i += 1) {
      expect(escalateReactUpdateDepthError(new Error(REACT_185_MINIFIED), SITE)).toBe(true)
    }
    await flushReactUpdateDepthEscalationsForTest()
    expect(recordRendererError).toHaveBeenCalledTimes(1)
    expect(captured).toHaveLength(1)
  })

  it('re-escalates the same site once the suppression window elapses', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // A report the user can send is the surface the guard exists to feed, so count the dialog signal too.
    recordRendererError.mockResolvedValue({
      ok: true,
      report: { id: 'react-report-1' },
      deduped: false
    })
    const reportsAvailable = vi.fn()
    window.addEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, reportsAvailable)
    try {
      expect(escalateReactUpdateDepthError(new Error(REACT_185_MINIFIED), SITE)).toBe(true)
      await flushReactUpdateDepthEscalationsForTest()
      expect(recordRendererError).toHaveBeenCalledTimes(1)

      // Inside the window the runaway loop's own re-entries stay suppressed.
      vi.setSystemTime(Date.now() + 9 * 60 * 1000)
      expect(escalateReactUpdateDepthError(new Error(REACT_185_MINIFIED), SITE)).toBe(true)
      await flushReactUpdateDepthEscalationsForTest()
      expect(recordRendererError).toHaveBeenCalledTimes(1)
      expect(captured).toHaveLength(1)
      expect(consoleError).toHaveBeenCalledTimes(1)

      // A later, unrelated runaway at the same catch must not be silent. Nothing is cleared here:
      // the report-key dedupe downstream has to expire on its own, or the window is decorative.
      vi.setSystemTime(Date.now() + 2 * 60 * 1000)
      expect(escalateReactUpdateDepthError(new Error(REACT_185_MINIFIED), SITE)).toBe(true)
      await flushReactUpdateDepthEscalationsForTest()
      expect(recordRendererError).toHaveBeenCalledTimes(2)
      expect(captured).toHaveLength(2)
      expect(consoleError).toHaveBeenCalledTimes(2)
      expect(reportsAvailable).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, reportsAvailable)
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it('still escalates a second, distinct catching site', async () => {
    escalateReactUpdateDepthError(new Error(REACT_185_MINIFIED), SITE)
    escalateReactUpdateDepthError(new Error(REACT_185_MINIFIED), 'startup-hydration.catalog')
    await flushReactUpdateDepthEscalationsForTest()
    expect(recordRendererError).toHaveBeenCalledTimes(2)
    expect(captured).toHaveLength(2)
  })

  it('leaves console evidence when the host cannot surface the report', async () => {
    // The web preload shim answers every recordRendererError with report: null, deduped: true,
    // and its recordBreadcrumb is a no-op, so the console is the only surface web users have.
    const { createWebDiagnosticsApi } = await import('../web/preload-api/web-diagnostics-api')
    window.api = createWebDiagnosticsApi() as unknown as typeof window.api
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(escalateReactUpdateDepthError(new Error(REACT_185_MINIFIED), SITE)).toBe(true)
    await flushReactUpdateDepthEscalationsForTest()

    expect(consoleError).toHaveBeenCalledTimes(1)
    const logged = consoleError.mock.calls[0]?.map(String).join(' ') ?? ''
    expect(logged).toContain(SITE)
    expect(logged).toContain('#185')
    consoleError.mockRestore()
  })

  it('never throws when the crash-report bridge is missing or fails', () => {
    window.api = undefined as unknown as typeof window.api
    expect(() => escalateReactUpdateDepthError(new Error(REACT_185_MINIFIED), SITE)).not.toThrow()

    resetReactUpdateDepthEscalationForTest()
    recordRendererError.mockImplementation(() => {
      throw new Error('IPC bridge torn down')
    })
    window.api = { crashReports: { recordRendererError } } as unknown as typeof window.api
    expect(() => escalateReactUpdateDepthError(new Error(REACT_185_DEV), SITE)).not.toThrow()
  })
})

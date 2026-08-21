import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportBreadcrumb } from '../../shared/crash-reporting'
import { rendererCrashBreadcrumbOrigin } from '../../shared/crash-breadcrumb-origin'

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (event: unknown, args?: unknown) => void>()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test', getAppMetrics: () => [] },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
    on: vi.fn((channel: string, listener: (event: unknown, args?: unknown) => void) => {
      listeners.set(channel, listener)
    })
  }
}))

vi.mock('../ipc/feedback', () => ({ submitFeedback: vi.fn() }))
vi.mock('../observability', () => ({
  collectDiagnosticBundle: vi.fn(),
  getDiagnosticsStatus: vi.fn()
}))
vi.mock('../observability/diagnostic-upload-endpoint', () => ({
  resolveDiagnosticOrcaChannel: vi.fn()
}))

import {
  _resetRendererErrorReportDedupeForTests,
  registerCrashReportingHandlers
} from '../ipc/crash-reporting'
import { clearCrashBreadcrumbsForTest, recordCrashBreadcrumb } from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'

/** Two live renderers: an Orca window and a browser-pane webview guest. */
const RENDERER_A = 11
const RENDERER_B = 22

const noMinidump = async () => null

type RecordedReport = { id: string; breadcrumbs?: CrashReportBreadcrumb[] }

function crashReportStore(): {
  record: ReturnType<typeof vi.fn>
  attachDetails: ReturnType<typeof vi.fn>
} {
  return {
    record: vi.fn(async (input: RecordedReport) => ({
      ...input,
      id: 'report-1'
    })),
    attachDetails: vi.fn(async () => null)
  }
}

function recordedBreadcrumbs(record: ReturnType<typeof vi.fn>): CrashReportBreadcrumb[] {
  const recorded = record.mock.calls[0]?.[0] as RecordedReport | undefined
  return recorded?.breadcrumbs ?? []
}

/** Main already knows the crashing webContents id here (index.ts passes it to
 *  getExpectedTeardownScope); the crash event is where it must survive. */
function rendererCrashEvent(webContentsId: number): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    webContentsId
  }
}

/** GPU/utility deaths have no window, so the report keeps the whole ring. */
function childCrashEvent(): ProcessGoneCrashEvent {
  return {
    source: 'child',
    processType: 'gpu-process',
    reason: 'crashed',
    exitCode: 5,
    expectedTeardown: 'none',
    details: { processType: 'gpu-process' }
  }
}

function emitRendererBreadcrumb(senderId: number, name: string, data?: unknown): void {
  listeners.get('crashReports:recordBreadcrumb')?.({ sender: { id: senderId } }, { name, data })
}

async function fileProcessGoneCrash(webContentsId: number): Promise<CrashReportBreadcrumb[]> {
  const store = crashReportStore()
  recordProcessGoneCrash(
    store as never,
    rendererCrashEvent(webContentsId),
    new ProcessGoneDedupe(),
    noMinidump
  )
  await Promise.resolve()
  return recordedBreadcrumbs(store.record)
}

async function fileReactErrorBoundaryReport(
  webContentsId: number
): Promise<CrashReportBreadcrumb[]> {
  const store = crashReportStore()
  registerCrashReportingHandlers(store as never)
  await handlers.get('crashReports:recordRendererError')?.(
    { sender: { id: webContentsId } },
    {
      boundaryId: 'workspace-shell-root',
      surface: 'workspace-shell',
      errorName: 'TypeError',
      errorMessage: 'Cannot read properties of undefined'
    }
  )
  return recordedBreadcrumbs(store.record)
}

const names = (breadcrumbs: CrashReportBreadcrumb[]): string[] => breadcrumbs.map((b) => b.name)

beforeEach(() => {
  handlers.clear()
  listeners.clear()
  setActiveSink({ push: vi.fn(), flush: vi.fn(), close: vi.fn() })
  clearCrashBreadcrumbsForTest()
  _resetRendererErrorReportDedupeForTests()
  registerCrashReportingHandlers(crashReportStore() as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
})

// Known and deliberate gap: the ring is still one shared 30-entry budget, so a
// chatty sibling can still evict the crashing renderer's crumbs before the
// report is filed. This suite covers attribution only; capacity is a separate
// change, so no assertion here depends on the ring overflowing.
describe('crash breadcrumb attribution across renderers', () => {
  it('does not attach a sibling renderer breadcrumb to a process-gone report', async () => {
    recordCrashBreadcrumb('app_started', { channel: 'stable' })
    emitRendererBreadcrumb(RENDERER_A, 'lazy_chunk_reload', {
      chunk: 'workspace-shell'
    })
    emitRendererBreadcrumb(RENDERER_B, 'lazy_chunk_reload_vetoed', {
      chunk: 'browser-guest'
    })

    const breadcrumbs = await fileProcessGoneCrash(RENDERER_A)

    // Main-process breadcrumbs are genuinely global and must stay on every report.
    expect(names(breadcrumbs)).toContain('app_started')
    expect(names(breadcrumbs)).toContain('lazy_chunk_reload')
    expect(names(breadcrumbs)).not.toContain('lazy_chunk_reload_vetoed')
  })

  it('keeps a quiet renderer own trail while other renderers churn', async () => {
    emitRendererBreadcrumb(RENDERER_A, 'renderer_bootstrap_started')
    emitRendererBreadcrumb(RENDERER_A, 'sidebar_worktree_activate')
    for (let generation = 0; generation < 20; generation += 1) {
      emitRendererBreadcrumb(100 + generation, 'popout_bootstrap_started')
    }

    const breadcrumbs = await fileProcessGoneCrash(RENDERER_A)

    expect(names(breadcrumbs)).toEqual(['renderer_bootstrap_started', 'sidebar_worktree_activate'])
  })

  it('keeps an identical coalesced storm on each emitting renderer report', async () => {
    // Both windows run the same bundle, so the same error fires in both at once.
    emitRendererBreadcrumb(RENDERER_A, 'renderer_error', { message: 'boom' })
    emitRendererBreadcrumb(RENDERER_B, 'renderer_error', { message: 'boom' })

    const forA = await fileProcessGoneCrash(RENDERER_A)
    const forB = await fileProcessGoneCrash(RENDERER_B)

    expect(names(forA)).toEqual(['renderer_error'])
    expect(names(forB)).toEqual(['renderer_error'])
    // Neither report may claim the sibling's occurrence as a suppressed repeat.
    expect(forA[0]?.data?.suppressedSinceLast).toBeUndefined()
    expect(forB[0]?.data?.suppressedSinceLast).toBeUndefined()
  })

  it('does not file one renderer payload under a name-only coalesced sibling', async () => {
    emitRendererBreadcrumb(RENDERER_A, 'terminal_safe_fit_retry_exhausted', { panes: 1 })
    emitRendererBreadcrumb(RENDERER_B, 'terminal_safe_fit_retry_exhausted', { panes: 9 })

    const forA = await fileProcessGoneCrash(RENDERER_A)
    const forB = await fileProcessGoneCrash(RENDERER_B)

    expect(forA[0]?.data?.panes).toBe(1)
    expect(forB[0]?.data?.panes).toBe(9)
  })

  it('still coalesces one renderer own repeats into a single entry', async () => {
    for (let repeat = 0; repeat < 5; repeat += 1) {
      emitRendererBreadcrumb(RENDERER_A, 'renderer_error', { message: 'boom' })
    }

    const forA = await fileProcessGoneCrash(RENDERER_A)

    expect(names(forA)).toEqual(['renderer_error'])
    expect(forA[0]?.data?.suppressedSinceLast).toBe(4)
  })

  it('does not attach a sibling renderer breadcrumb to a react-error-boundary report', async () => {
    recordCrashBreadcrumb('app_started', { channel: 'stable' })
    emitRendererBreadcrumb(RENDERER_A, 'lazy_chunk_reload', {
      chunk: 'workspace-shell'
    })
    emitRendererBreadcrumb(RENDERER_B, 'lazy_chunk_reload_vetoed', {
      chunk: 'browser-guest'
    })

    const breadcrumbs = await fileReactErrorBoundaryReport(RENDERER_A)

    expect(names(breadcrumbs)).toContain('app_started')
    expect(names(breadcrumbs)).toContain('lazy_chunk_reload')
    expect(names(breadcrumbs)).not.toContain('lazy_chunk_reload_vetoed')
  })

  it('keeps every renderer trail on a child crash that names no webContents', async () => {
    recordCrashBreadcrumb('app_started', { channel: 'stable' })
    emitRendererBreadcrumb(RENDERER_A, 'lazy_chunk_reload', { chunk: 'workspace-shell' })
    emitRendererBreadcrumb(RENDERER_B, 'lazy_chunk_reload_vetoed', { chunk: 'browser-guest' })

    const store = crashReportStore()
    recordProcessGoneCrash(store as never, childCrashEvent(), new ProcessGoneDedupe(), noMinidump)
    await Promise.resolve()

    // Why: no surface filed this, so scoping it would delete real evidence.
    expect(names(recordedBreadcrumbs(store.record))).toEqual([
      'app_started',
      'lazy_chunk_reload',
      'lazy_chunk_reload_vetoed'
    ])
  })

  it('stores the origin label sanitization leaves untouched, so filtering matches', async () => {
    emitRendererBreadcrumb(RENDERER_A, 'lazy_chunk_reload', { chunk: 'workspace-shell' })

    const store = crashReportStore()
    recordProcessGoneCrash(store as never, childCrashEvent(), new ProcessGoneDedupe(), noMinidump)
    await Promise.resolve()

    // Why: the reporter builds this label raw while recording sanitizes it; if
    // sanitizing ever rewrote it the filter would silently drop the crumbs.
    const stored = recordedBreadcrumbs(store.record).find((b) => b.name === 'lazy_chunk_reload')
    expect(stored?.origin).toBe(rendererCrashBreadcrumbOrigin(RENDERER_A))
  })
})

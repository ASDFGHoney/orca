import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: (): unknown[] => []
  }
}))

import { rendererCrashBreadcrumbOrigin } from '../../shared/crash-breadcrumb-origin'
import { clearCrashBreadcrumbsForTest, recordCrashBreadcrumb } from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'

const CRASHED_WEB_CONTENTS_ID = 11
const SIBLING_WEB_CONTENTS_ID = 22
const noMinidump = async () => null

function killedEvent(overrides: Partial<ProcessGoneCrashEvent> = {}): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'killed',
    exitCode: 1,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    webContentsId: CRASHED_WEB_CONTENTS_ID,
    ...overrides
  }
}

function recordedDetails(record: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const input = record.mock.calls[0]?.[0] as { details?: Record<string, unknown> } | undefined
  return input?.details ?? {}
}

type SpanRecord = { name?: string; attributes?: Record<string, unknown> }

let spans: SpanRecord[]

function spanNamed(name: string): SpanRecord | undefined {
  return spans.find((span) => span.name === name)
}

beforeEach(() => {
  spans = []
  const sink: TracerSink = {
    push: (record) => spans.push(record as SpanRecord),
    flush: vi.fn(),
    close: vi.fn()
  }
  setActiveSink(sink)
  clearCrashBreadcrumbsForTest()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
})

describe('renderer silence on process-gone reports', () => {
  it('stamps how long the crashing renderer had been silent before a killed/1 death', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T11:01:20.000Z'))
    recordCrashBreadcrumb(
      'renderer_memory',
      { reason: 'interval', usedHeapMB: 120 },
      rendererCrashBreadcrumbOrigin(CRASHED_WEB_CONTENTS_ID)
    )
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    expect(recordedDetails(record)).toMatchObject({
      rendererHeartbeatStatus: 'observed',
      rendererHeartbeatAttribution: 'crashed-renderer',
      rendererHeartbeatSilenceMs: 810_000,
      rendererHeartbeatMissedIntervals: 13
    })
  })

  it('does not credit the crashing renderer with a sibling renderer heartbeat', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T11:01:20.000Z'))
    recordCrashBreadcrumb(
      'renderer_memory',
      { reason: 'interval' },
      rendererCrashBreadcrumbOrigin(CRASHED_WEB_CONTENTS_ID)
    )
    vi.setSystemTime(Date.parse('2026-08-20T11:14:20.000Z'))
    recordCrashBreadcrumb(
      'renderer_memory',
      { reason: 'interval' },
      rendererCrashBreadcrumbOrigin(SIBLING_WEB_CONTENTS_ID)
    )
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    expect(recordedDetails(record)).toMatchObject({
      rendererHeartbeatSilenceMs: 810_000,
      rendererHeartbeatAttribution: 'crashed-renderer'
    })
  })

  it('does not read an OS sleep as a wedged renderer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T03:00:20.000Z'))
    recordCrashBreadcrumb(
      'renderer_memory',
      { reason: 'interval', usedHeapMB: 120 },
      rendererCrashBreadcrumbOrigin(CRASHED_WEB_CONTENTS_ID)
    )
    vi.setSystemTime(Date.parse('2026-08-20T11:14:20.000Z'))
    recordCrashBreadcrumb('system_slept', { suspendedForMs: 29_580_000 })
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    expect(recordedDetails(record)).toMatchObject({
      rendererHeartbeatSilenceMs: 29_670_000,
      rendererHeartbeatSuspendedMs: 29_580_000,
      rendererHeartbeatAwakeSilenceMs: 90_000,
      rendererHeartbeatMissedIntervals: 1
    })
  })

  it('records that no heartbeat was seen rather than omitting the field', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    expect(recordedDetails(record)).toMatchObject({
      rendererHeartbeatStatus: 'none'
    })
  })

  it('does not stamp a renderer heartbeat verdict on a child-process death', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T11:00:20.000Z'))
    recordCrashBreadcrumb(
      'renderer_memory',
      { reason: 'interval', usedHeapMB: 120 },
      rendererCrashBreadcrumbOrigin(CRASHED_WEB_CONTENTS_ID)
    )
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      killedEvent({
        source: 'child',
        processType: 'utility',
        reason: 'crashed',
        exitCode: 133,
        details: { processType: 'utility', serviceName: 'storage.mojom.StorageService' },
        webContentsId: undefined
      }),
      new ProcessGoneDedupe(),
      noMinidump
    )

    const details = recordedDetails(record)
    expect(details).not.toHaveProperty('rendererHeartbeatStatus')
    expect(details).not.toHaveProperty('rendererHeartbeatSilenceMs')
    expect(details).not.toHaveProperty('rendererHeartbeatMissedIntervals')
  })
})

describe('minidump status on process-gone reports', () => {
  // Why: the dump wait runs up to 8s after the record is written, so a main
  // process that exits with the renderer (the killed/1 shape) never attaches.
  it('stamps a pending minidump status at record time', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      () => new Promise(() => {})
    )

    expect(recordedDetails(record)).toMatchObject({
      minidumpStatus: 'pending'
    })
  })

  it('replaces the pending status once the dump wait resolves', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const attach = vi.fn().mockResolvedValue(null)

    recordProcessGoneCrash(
      { record, attachDetails: attach } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    await vi.waitFor(() =>
      expect(attach).toHaveBeenCalledWith('report-1', {
        minidumpStatus: 'absent'
      })
    )
  })

  it('replaces the pending status when the terminal attach write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })
    const attach = vi.fn().mockRejectedValueOnce(new Error('EPERM')).mockResolvedValue(null)

    recordProcessGoneCrash(
      { record, attachDetails: attach } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    await vi.waitFor(() =>
      expect(attach).toHaveBeenCalledWith('report-1', {
        minidumpStatus: 'attach-failed'
      })
    )
  })
})

describe('minidump status on the process-gone span', () => {
  it('does not stamp a dump status the span is serialized too early to know', () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    const details = spanNamed('electron.process_gone')?.attributes?.details as Record<
      string,
      unknown
    >
    expect(details).toBeDefined()
    expect(details).not.toHaveProperty('minidumpStatus')
  })

  it('emits the terminal dump status on its own span once the wait resolves', async () => {
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    await vi.waitFor(() =>
      expect(spanNamed('electron.minidump_signature')?.attributes).toMatchObject({
        'crash.report_id': 'report-1',
        'crash.minidump_status': 'absent'
      })
    )
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test', getAppMetrics: () => [] }
}))

import { clearCrashBreadcrumbsForTest, getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'
import { resetSuppressedProcessGoneRingBudgetForTest } from './suppressed-process-gone-ring-budget'

const records: unknown[] = []
const sink: TracerSink = {
  push: (record) => records.push(record),
  flush: vi.fn(),
  close: vi.fn()
}

/** A repeatable CHECK failure inside an on-demand Chromium utility service. */
function printCompositorCheckFailure(): ProcessGoneCrashEvent {
  return {
    source: 'child',
    processType: 'utility',
    reason: 'crashed',
    exitCode: 0x80000003,
    expectedTeardown: 'none',
    details: { processType: 'utility', serviceName: 'printing.mojom.PrintCompositor' }
  }
}

function suppress(capture: unknown): { record: ReturnType<typeof vi.fn> } {
  const store = { record: vi.fn(async () => 'report-1'), attachDetails: vi.fn(async () => null) }
  recordProcessGoneCrash(
    store as never,
    printCompositorCheckFailure(),
    new ProcessGoneDedupe(),
    capture as never
  )
  return store
}

beforeEach(() => {
  records.length = 0
  setActiveSink(sink)
  clearCrashBreadcrumbsForTest()
  resetSuppressedProcessGoneRingBudgetForTest()
  resetProcessGoneSiblingCorrelationForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  resetSuppressedProcessGoneRingBudgetForTest()
  resetProcessGoneSiblingCorrelationForTest()
})

// Pins the contract stated on isRecoverableChromiumUtilityService: suppression is
// breadcrumb-only, so widening the denylist is the ONLY way to keep a service's
// post-mortem detail. A suppressed exit must never pay for a minidump poll either
// -- Chromium can crash-loop these at 1459/min.
describe('suppressed Chromium utility crash diagnosability', () => {
  it('never reaches the minidump signature path', async () => {
    const capture = vi.fn(async () => null)

    const store = suppress(capture)
    await Promise.resolve()

    expect(store.record).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(records).not.toContainEqual(
      expect.objectContaining({ name: 'electron.minidump_signature' })
    )
  })

  it('leaves the CHECK anonymous in the durable breadcrumb trail', () => {
    suppress(async () => null)

    const [breadcrumb] = getCrashBreadcrumbSnapshot()
    expect(breadcrumb).toEqual(
      expect.objectContaining({
        name: 'process_gone_suppressed',
        data: expect.objectContaining({
          source: 'child',
          processType: 'utility',
          serviceName: 'printing.mojom.PrintCompositor',
          reason: 'crashed',
          exitCode: 0x80000003
        })
      })
    )
    expect(Object.keys(breadcrumb.data ?? {})).toEqual(
      expect.not.arrayContaining(['minidumpStatus', 'minidumpPath', 'crashSignature'])
    )
  })
})

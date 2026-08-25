import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const parseMinidumpCrashSignatureMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: () => [],
    getPath: () => '/unused-in-tests'
  },
  crashReporter: { start: vi.fn() }
}))
vi.mock('./minidump-crash-signature', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseMinidumpCrashSignature: parseMinidumpCrashSignatureMock
}))

import { _setCrashpadCaptureStateForTest, captureMinidumpSignature } from './crashpad-capture'
import { clearCrashBreadcrumbsForTest } from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import { resetSuppressedProcessGoneRingBudgetForTest } from './suppressed-process-gone-ring-budget'

let dumpDir: string

/** Minimal but valid minidump header; the signature parser is mocked. */
function emptyDump(): Buffer {
  const buf = Buffer.alloc(32)
  buf.writeUInt32LE(0x504d444d, 0)
  buf.writeUInt32LE(0xa793, 4)
  buf.writeUInt32LE(0, 8)
  buf.writeUInt32LE(32, 12)
  return buf
}

async function writeDump(relativePath: string, mtimeMs: number): Promise<string> {
  const filePath = path.join(dumpDir, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, emptyDump())
  await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000)
  return filePath
}

/** Suppressed by the Chromium-utility default; leaves an unreported dump behind. */
function printCompositorCheckFailure(): ProcessGoneCrashEvent {
  return {
    source: 'child',
    processType: 'utility',
    reason: 'crashed',
    exitCode: 0x80000003,
    expectedTeardown: 'none',
    details: { type: 'Utility', serviceName: 'printing.mojom.PrintCompositor' }
  }
}

/** Reportable: `launch-failed` is not recoverable churn, and it never ran, so it
 *  has no dump of its own to pair with. */
function videoCaptureLaunchFailure(): ProcessGoneCrashEvent {
  return {
    source: 'child',
    processType: 'utility',
    reason: 'launch-failed',
    exitCode: null,
    expectedTeardown: 'none',
    details: { type: 'Utility', serviceName: 'video_capture.mojom.VideoCaptureService' }
  }
}

function recorderStore() {
  return {
    record: vi.fn(async () => ({ id: 'report-1' })),
    attachDetails: vi.fn(async () => null)
  }
}

// Bounded poll: the recorder's real capture would spin for 8s when no dump matches.
const capture = (crashedAtMs: number, expectedProcessType: string) =>
  captureMinidumpSignature(crashedAtMs, { expectedProcessType, timeoutMs: 0 })

beforeEach(async () => {
  parseMinidumpCrashSignatureMock.mockReset()
  parseMinidumpCrashSignatureMock.mockReturnValue({
    processType: 'utility',
    checkMessage: '[0125/000000.000:FATAL:print_compositor.cc(42)] Check failed: alive.',
    checkFile: 'print_compositor.cc',
    checkLine: 42,
    annotations: {}
  })
  dumpDir = await mkdtemp(path.join(os.tmpdir(), 'orca-suppressed-dump-'))
  _setCrashpadCaptureStateForTest({ dumpDirectory: dumpDir, started: true })
  setActiveSink({ push: vi.fn(), flush: vi.fn(), close: vi.fn() })
  clearCrashBreadcrumbsForTest()
  resetSuppressedProcessGoneRingBudgetForTest()
  resetProcessGoneSiblingCorrelationForTest()
})

afterEach(async () => {
  _setCrashpadCaptureStateForTest(null)
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
  resetSuppressedProcessGoneRingBudgetForTest()
  resetProcessGoneSiblingCorrelationForTest()
  await rm(dumpDir, { recursive: true, force: true })
})

describe('minidump attribution after a suppressed utility crash', () => {
  it('never hands a suppressed service dump to an unrelated utility report', async () => {
    const store = recorderStore()
    const dedupe = new ProcessGoneDedupe()

    recordProcessGoneCrash(store as never, printCompositorCheckFailure(), dedupe, capture)
    await writeDump(path.join('reports', 'print-compositor.dmp'), Date.now() + 100)
    recordProcessGoneCrash(store as never, videoCaptureLaunchFailure(), dedupe, capture)

    await vi.waitFor(() => expect(store.attachDetails).toHaveBeenCalled())
    expect(store.attachDetails).toHaveBeenCalledWith('report-1', { minidumpStatus: 'absent' })
  })

  it('still pairs a reportable utility crash with its own dump', async () => {
    const store = recorderStore()

    await writeDump(path.join('reports', 'video-capture.dmp'), Date.now() + 100)
    recordProcessGoneCrash(
      store as never,
      videoCaptureLaunchFailure(),
      new ProcessGoneDedupe(),
      capture
    )

    await vi.waitFor(() => expect(store.attachDetails).toHaveBeenCalled())
    expect(store.attachDetails).toHaveBeenCalledWith(
      'report-1',
      expect.objectContaining({ minidumpStatus: 'captured' })
    )
  })
})

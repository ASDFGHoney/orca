import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test', getAppMetrics: () => [] }
}))

import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { resetProcessGoneSiblingCorrelationForTest } from './process-gone-sibling-correlation'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import { resetSuppressedProcessGoneRingBudgetForTest } from './suppressed-process-gone-ring-budget'

// Chromium services that all suppress by default, so each one is its own coalesce
// key: an OOM sweep or shutdown race can burst the whole set inside one window.
const CHROMIUM_SERVICES = [
  'proxy_resolver.mojom.ProxyResolverFactory',
  'printing.mojom.PrintCompositor',
  'data_decoder.mojom.DataDecoderService',
  'tracing.mojom.TracedProcess',
  'media.mojom.MediaFoundationService',
  'device.mojom.DeviceService',
  'shape_detection.mojom.ShapeDetectionService',
  'unzip.mojom.Unzipper',
  'patch.mojom.FilePatcher',
  'quarantine.mojom.Quarantine',
  'screen_ai.mojom.ScreenAIService',
  'speech_recognition.mojom.SpeechRecognitionService',
  'paint_preview.mojom.PaintPreviewCompositorCollection',
  'video_effects.mojom.VideoEffectsService',
  'file_util.mojom.SafeArchiveAnalyzer'
]

function utilityCrash(serviceName: string, exitCode: number): ProcessGoneCrashEvent {
  return {
    source: 'child',
    processType: 'Utility',
    reason: 'crashed',
    exitCode,
    expectedTeardown: 'none',
    details: { type: 'Utility', serviceName }
  }
}

beforeEach(() => {
  setActiveSink({ push: vi.fn(), flush: vi.fn(), close: vi.fn() })
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

describe('suppressed process-gone breadcrumb ring budget', () => {
  it('leaves the pre-crash trail intact when a whole service population churns', () => {
    const dedupe = new ProcessGoneDedupe()
    for (let index = 0; index < 20; index += 1) {
      recordCrashBreadcrumb('user_action', { step: index })
    }

    for (const serviceName of CHROMIUM_SERVICES) {
      for (const exitCode of [139, 11]) {
        recordProcessGoneCrash(
          { record: vi.fn() } as never,
          utilityCrash(serviceName, exitCode),
          dedupe
        )
      }
    }

    const names = getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.name)
    expect({
      userAction: names.filter((name) => name === 'user_action').length,
      suppressed: names.filter((name) => name === 'process_gone_suppressed').length
    }).toEqual({ userAction: 20, suppressed: 6 })
  })
})

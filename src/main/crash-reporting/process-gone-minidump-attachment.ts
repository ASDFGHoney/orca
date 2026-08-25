import { sanitizeCrashReportDetails } from '../../shared/crash-reporting'
import type { CrashReportStore } from './crash-report-store'
import { captureMinidumpSignature, type CapturedMinidump } from './crashpad-capture'
import { minidumpSignatureDetails } from './minidump-crash-signature'
import type { ProcessGoneSource } from './process-gone-classification'
import { flushActiveSink, startSpan } from '../observability/tracer'

type MinidumpDetailStore = Pick<CrashReportStore, 'attachDetails'>

/** Injectable so tests can drive the pairing without a Crashpad handler. */
export type MinidumpCapture = (
  crashedAtMs: number,
  expectedProcessType: string
) => Promise<CapturedMinidump | null>

const CHILD_CRASHPAD_PROCESS_TYPES: Readonly<Record<string, string>> = {
  gpu: 'gpu-process',
  utility: 'utility',
  zygote: 'zygote'
}

export function expectedCrashpadProcessType(
  source: ProcessGoneSource,
  processType: string
): string | null {
  return source === 'renderer'
    ? 'renderer'
    : (CHILD_CRASHPAD_PROCESS_TYPES[processType.trim().toLowerCase()] ?? null)
}

export const captureProcessMinidump: MinidumpCapture = (crashedAtMs, expectedProcessType) =>
  captureMinidumpSignature(crashedAtMs, { expectedProcessType })

// Why: the crash-report record is capped at 5 entries and is user-facing; the span
// is what makes the outcome countable in the diagnostics bundle. Emitted for the
// absent case too, so a trace can tell "no dump was written" from a process-gone
// span with no status at all -- the main process exited first (the killed/1 shape).
function recordMinidumpStatusSpan(
  reportId: string,
  status: 'captured' | 'absent',
  attributes: Record<string, unknown> = {}
): void {
  const span = startSpan('electron.minidump_signature', {
    attributes: { 'crash.report_id': reportId, 'crash.minidump_status': status, ...attributes }
  })
  span.end()
  flushActiveSink()
}

/**
 * Best effort, so a store that is failing writes cannot leave `pending` on disk —
 * which reads as "the dump wait never ran" rather than "the attach write failed".
 */
export async function markMinidumpAttachFailed(
  store: MinidumpDetailStore,
  reportId: string
): Promise<void> {
  try {
    await store.attachDetails(reportId, { minidumpStatus: 'attach-failed' })
  } catch {
    // The caller already logged and breadcrumbed the original failure.
  }
}

/**
 * Folds the Crashpad signature into a report that is already on disk.
 *
 * Why separate from the record write: an exit code of 0x80000003 only says "a
 * CHECK fired"; the name, file and line live in the dump, which Crashpad is
 * still writing when process-gone fires. Waiting inline would stall recovery.
 * The record carries `minidumpStatus: 'pending'` until this lands, so a wait that
 * never completes leaves that state visible instead of no field.
 */
export async function attachMinidumpSignature(
  store: MinidumpDetailStore,
  reportId: string,
  crashedAtMs: number,
  expectedProcessType: string | null,
  capture: MinidumpCapture
): Promise<void> {
  const captured = expectedProcessType ? await capture(crashedAtMs, expectedProcessType) : null
  if (!captured) {
    await store.attachDetails(reportId, { minidumpStatus: 'absent' })
    recordMinidumpStatusSpan(reportId, 'absent')
    return
  }
  const signatureDetails = sanitizeCrashReportDetails(minidumpSignatureDetails(captured.signature))
  await store.attachDetails(reportId, {
    ...signatureDetails,
    minidumpStatus: 'captured',
    minidumpPath: captured.filePath,
    minidumpBytes: captured.sizeBytes
  })
  recordMinidumpStatusSpan(reportId, 'captured', {
    'crash.minidump_bytes': captured.sizeBytes,
    ...signatureDetails
  })
}

// Chromium spawns utility services on demand and tears them down as routine
// churn, so an allowlist of them can only ever be behind: 1.4.188 filed the PAC
// evaluator and the print compositor as user-facing crashes because neither was
// enumerated. We cannot enumerate Chromium's service list, but we can enumerate
// the services whose death is ours to answer for, so the default inverts and the
// exceptions below carry the enumeration.
const NON_RECOVERABLE_UTILITY_SERVICE_NAMES = new Set([
  // Electron's utilityProcess.fork() host: this is Orca's own code dying.
  'node.mojom.NodeService',
  // Backs durable profile storage, so an exit can mean real user data loss.
  'storage.mojom.StorageService'
])

// Mojo service names are `<module>.mojom.<Interface>`; anything else is not a
// Chromium-owned service and has to keep reporting.
const CHROMIUM_MOJO_SERVICE_NAME = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*\.mojom\.[A-Za-z0-9_]+$/

/**
 * Whether a `child-process-gone` utility exit is routine Chromium churn.
 *
 * Suppression is breadcrumb-only. The exit lands in the durable trail as
 * `process_gone_suppressed` carrying {source, processType, serviceName, reason,
 * exitCode} and nothing more: no crash report, no minidump signature, no
 * `electron.minidump_signature` span in the diagnostic bundle, and the dump is
 * never claimed, so pruning can reclaim it. A suppressed CHECK failure stays an
 * anonymous 0x80000003 -- no name, file, line or stack survives anywhere.
 * So deny a service below whenever we would need that post-mortem detail to act
 * on its death, not merely when the service sounds important.
 */
export function isRecoverableChromiumUtilityService(serviceName: string | undefined): boolean {
  if (serviceName === undefined || NON_RECOVERABLE_UTILITY_SERVICE_NAMES.has(serviceName)) {
    return false
  }
  return CHROMIUM_MOJO_SERVICE_NAME.test(serviceName)
}

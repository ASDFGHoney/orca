import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'

const STORAGE_IDENTITY_VERSION = 1
const STORAGE_IDENTITY_TAG = 'orca-browser-execution-host-storage'

/**
 * Storage identity of an execution host: the components that must keep browser
 * storage attached to the same partition.
 *
 * This is deliberately narrower than `browserNetworkExecutionHostKey`, which is
 * the route/tunnel fencing key. The fencing key embeds per-boot values (native
 * and WSL `revision` = the runtime's start time, SSH `connectionGeneration` and
 * `providerEpoch`); hashing those into the partition name minted a fresh
 * Chromium partition on every runtime restart or SSH reconnect and silently
 * dropped cookies and localStorage.
 *
 * Non-reusable record identity is preserved: a deleted-and-readded SSH target
 * gets a freshly minted `targetId`, and a re-registered runtime gets a fresh
 * `runtimeId`, so neither inherits the previous record's storage.
 */
export function browserNetworkExecutionHostStorageIdentity(
  host: BrowserNetworkExecutionHost
): string {
  if (host.kind === 'native') {
    return browserNativeExecutionHostStorageIdentity(host.runtimeId)
  }
  if (host.kind === 'wsl') {
    return storageIdentity(['wsl', host.runtimeId, host.distro])
  }
  // Why: providerEpoch is a per-connection fencing nonce reissued on every
  // reconnect, not a persistent record id -- targetId already carries non-reuse.
  return storageIdentity(['ssh', host.targetId])
}

/** Storage identity of a runtime's own machine, for callers with no execution-host record. */
export function browserNativeExecutionHostStorageIdentity(runtimeId: string): string {
  return storageIdentity(['native', runtimeId])
}

function storageIdentity(components: readonly string[]): string {
  return JSON.stringify([STORAGE_IDENTITY_TAG, STORAGE_IDENTITY_VERSION, ...components])
}

import { app, session } from 'electron'
import { rm } from 'node:fs/promises'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { deriveBrowserRoutePartitionStorageScope } from './browser-route-identity'
import {
  findBrowserRoutePartitionsForStorageScope,
  findOrphanedBrowserRoutePartitions,
  releaseBrowserRoutePartitionStorage,
  type BrowserRoutePartitionStorageDependencies
} from './browser-route-partition-storage-lifecycle'
import {
  activeBrowserRoutePartitionOrcaProfileId,
  currentBrowserRoutePartitionBindingStore,
  routePartitionDataRoot
} from './browser-route-partition-binding-runtime'
import { browserRouteSessionRegistry } from './browser-route-session-runtime'
import { browserSessionRegistry } from './browser-session-registry'

/**
 * Sweeps route partitions whose owning environment record is gone.
 *
 * Runs at startup only, and never treats a disconnected host as removed: an
 * environment that still exists in the store keeps every partition it owns.
 */
export async function collectOrphanedBrowserRoutePartitionStorage(): Promise<string[]> {
  const orcaProfileId = activeBrowserRoutePartitionOrcaProfileId()
  if (!orcaProfileId) {
    return []
  }
  const dependencies = storageDependencies()
  const liveStorageScopes = new Set(
    listEnvironments(app.getPath('userData')).map((environment) =>
      deriveBrowserRoutePartitionStorageScope({ orcaProfileId, environmentId: environment.id })
    )
  )
  const orphans = findOrphanedBrowserRoutePartitions(dependencies, liveStorageScopes)
  if (orphans.length === 0) {
    return []
  }
  const released = await releaseBrowserRoutePartitionStorage(dependencies, orphans)
  reportStorageFailures('orphan collection', released.failures)
  return released.clearedPartitions
}

/** Destroys the storage of every route partition owned by a removed environment. */
export async function clearBrowserRoutePartitionStorageForEnvironment(
  environmentId: string
): Promise<string[]> {
  const orcaProfileId = activeBrowserRoutePartitionOrcaProfileId()
  if (!orcaProfileId) {
    return []
  }
  const dependencies = storageDependencies()
  const partitions = findBrowserRoutePartitionsForStorageScope(
    dependencies,
    deriveBrowserRoutePartitionStorageScope({ orcaProfileId, environmentId })
  )
  if (partitions.length === 0) {
    return []
  }
  const released = await releaseBrowserRoutePartitionStorage(dependencies, partitions)
  reportStorageFailures('environment removal', released.failures)
  return released.clearedPartitions
}

function storageDependencies(): BrowserRoutePartitionStorageDependencies {
  return {
    bindings: currentBrowserRoutePartitionBindingStore(),
    partitionDataRoot: routePartitionDataRoot(),
    isPartitionLive: (partition) => browserRouteSessionRegistry.isPartitionRetained(partition),
    clearPartitionStorage: async (partition) => {
      const partitionSession = session.fromPartition(partition)
      await partitionSession.clearStorageData()
      await partitionSession.clearCache()
      browserSessionRegistry.clearRoutePartitionPolicies(partition)
    },
    // Why: force ignores an already-absent directory, keeping the sweep idempotent.
    removePartitionDirectory: (directory) => rm(directory, { recursive: true, force: true })
  }
}

function reportStorageFailures(stage: string, failures: readonly unknown[]): void {
  for (const failure of failures) {
    console.warn(
      `[browser-route-partition] ${stage} failed:`,
      failure instanceof Error ? failure.message : String(failure)
    )
  }
}

import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { BrowserClientPageMetadataParams } from '../../../../shared/browser-client-page-metadata-protocol'
import {
  BrowserClientHostAttachParams,
  BrowserClientHostCommandResultParams
} from '../../../../shared/browser-client-host-protocol'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from '../../runtime-browser-page-registry'
import { recoverUnavailableRuntimeBrowserClientPages } from '../../runtime-browser-client-page-recovery'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'

export const BROWSER_CLIENT_HOST_METHODS: RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'browser.clientHost.attach',
    params: BrowserClientHostAttachParams,
    handler: async (
      params,
      { runtime, connectionId, pairedDeviceId, clientKind, clientCapabilities, signal },
      emit
    ) => {
      if (clientKind !== 'runtime' || !connectionId || !pairedDeviceId) {
        throw new Error('authenticated_browser_client_host_required')
      }
      if (!clientCapabilities?.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)) {
        throw new Error('browser_client_host_capability_required')
      }
      if (params.authorityRuntimeId !== runtime.getRuntimeId()) {
        throw new Error('browser_client_host_authority_mismatch')
      }

      const registry = getBrowserHostLeaseRegistry(runtime)
      const handle = registry.attach({
        browserHostClientId: params.browserHostClientId,
        connectionId,
        pairedDeviceId,
        hostCapabilities: params.hostCapabilities,
        pageCommandProtocolVersion: params.pageCommandProtocolVersion,
        pageInventoryProtocolVersion: params.pageInventoryProtocolVersion,
        pageInventory: params.pageInventory,
        pageReconciliationProtocolVersion: params.pageReconciliationProtocolVersion,
        leaseReconnectProtocolVersion: params.leaseReconnectProtocolVersion
      })
      let releaseCommandDelivery = (): void => {}
      let resolveDisconnected = (): void => {}
      const whenDisconnected = new Promise<void>((resolve) => {
        resolveDisconnected = resolve
      })
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        releaseCommandDelivery()
        handle.disconnect()
        resolveDisconnected()
      }
      const subscriptionId = `browser-client-host:${params.browserHostClientId}`
      try {
        runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
        signal?.addEventListener('abort', cleanup, { once: true })
        if (signal?.aborted) {
          cleanup()
          return
        }
        emit({
          type: 'ready',
          authorityEpoch: handle.lease.authorityEpoch,
          browserHostGeneration: handle.lease.browserHostGeneration,
          ...(params.pageCommandProtocolVersion
            ? { pageCommandProtocolVersion: params.pageCommandProtocolVersion }
            : {}),
          ...(params.pageInventoryProtocolVersion
            ? { pageInventoryProtocolVersion: params.pageInventoryProtocolVersion }
            : {}),
          ...(params.leaseReconnectProtocolVersion
            ? { leaseReconnectProtocolVersion: params.leaseReconnectProtocolVersion }
            : {}),
          ...(params.pageReconciliationProtocolVersion
            ? { pageReconciliationProtocolVersion: params.pageReconciliationProtocolVersion }
            : {})
        })
        if (params.pageCommandProtocolVersion) {
          releaseCommandDelivery = registry.attachCommandDelivery(
            {
              authorityEpoch: handle.lease.authorityEpoch,
              browserHostClientId: handle.lease.browserHostClientId,
              browserHostGeneration: handle.lease.browserHostGeneration,
              pairedDeviceId
            },
            emit
          )
        }
        await recoverUnavailableRuntimeBrowserClientPages({
          lease: handle.lease,
          authority: registry,
          pages: getRuntimeBrowserPageRegistry(runtime),
          notifyWorkspace: (workspaceId) => runtime.notifyMobileSessionTabsChanged(workspaceId)
        })
        const reason = await Promise.race([
          handle.whenFenced,
          whenDisconnected.then(() => undefined),
          handle.whenConnectionSuperseded.then(() => undefined)
        ])
        if (!reason) {
          return
        }
        emit({
          type: 'revoked',
          authorityEpoch: handle.lease.authorityEpoch,
          browserHostGeneration: handle.lease.browserHostGeneration,
          reason: reason === 'replaced' ? 'replaced' : 'released'
        })
      } finally {
        signal?.removeEventListener('abort', cleanup)
        cleanup()
      }
    }
  }),
  defineMethod({
    name: 'browser.clientHost.commandResult',
    params: BrowserClientHostCommandResultParams,
    handler: (
      params,
      { runtime, pairedDeviceId, connectionId, clientKind, clientCapabilities }
    ) => {
      if (clientKind !== 'runtime' || !pairedDeviceId || !connectionId) {
        throw new Error('authenticated_browser_client_host_required')
      }
      if (!clientCapabilities?.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)) {
        throw new Error('browser_client_host_capability_required')
      }
      if (params.authorityRuntimeId !== runtime.getRuntimeId()) {
        throw new Error('browser_client_host_authority_mismatch')
      }
      const accepted = getBrowserHostLeaseRegistry(runtime).settleClientPageCommand(
        {
          authorityEpoch: params.authorityEpoch,
          browserHostClientId: params.browserHostClientId,
          browserHostGeneration: params.browserHostGeneration,
          pairedDeviceId,
          connectionId
        },
        params
      )
      return { accepted }
    }
  }),
  defineMethod({
    name: 'browser.clientHost.pageMetadata',
    params: BrowserClientPageMetadataParams,
    handler: (
      params,
      { runtime, pairedDeviceId, connectionId, clientKind, clientCapabilities }
    ) => {
      if (clientKind !== 'runtime' || !pairedDeviceId || !connectionId) {
        throw new Error('authenticated_browser_client_host_required')
      }
      if (
        !clientCapabilities?.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY) ||
        !clientCapabilities.includes(BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY)
      ) {
        throw new Error('browser_client_page_metadata_capability_required')
      }
      const placement = {
        kind: 'client' as const,
        browserHostClientId: params.browserHostClientId,
        browserHostGeneration: params.browserHostGeneration,
        pageHostGeneration: params.pageHostGeneration
      }
      getBrowserHostLeaseRegistry(runtime).requireClientPageConnection({
        browserPageId: params.browserPageId,
        placement,
        pairedDeviceId,
        connectionId
      })
      const pages = getRuntimeBrowserPageRegistry(runtime)
      const page = pages.getPage(params.browserPageId)
      if (!page) {
        throw new Error('browser_runtime_page_required')
      }
      const accepted = pages.updatePageMetadata(params.browserPageId, placement, params)
      if (accepted) {
        runtime.notifyMobileSessionTabsChanged(page.workspaceId)
      }
      return { accepted }
    }
  })
]

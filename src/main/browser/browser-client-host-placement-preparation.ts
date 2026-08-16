import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import type {
  BrowserClientHostPlacementPreference,
  BrowserPageCreationPlacement
} from '../../shared/browser-client-host-placement'
import {
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'

const SERVER_PLACEMENT = Object.freeze({ kind: 'server' as const })
const REQUIRED_RUNTIME_CAPABILITIES = [
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
] as const

type BrowserClientHostPlacementPreparationOptions = {
  selector: string
  expectedPairingRevision?: number
  preference: BrowserClientHostPlacementPreference
  enabled: boolean
  resolveEnvironment: (selector: string) => KnownRuntimeEnvironment
  getStatus: (environmentId: string) => Promise<RuntimeRpcResponse<RuntimeStatus>>
  startHost: (options: {
    environment: KnownRuntimeEnvironment
    authorityRuntimeId: string
  }) => Promise<BrowserClientHostLeaseAuthority>
  closeHost: (environmentId: string, error?: Error) => Promise<boolean>
}

export async function prepareBrowserClientHostPlacement(
  options: BrowserClientHostPlacementPreparationOptions
): Promise<BrowserPageCreationPlacement> {
  if (!options.enabled || options.preference === 'server') {
    return SERVER_PLACEMENT
  }

  const initialEnvironment = options.resolveEnvironment(options.selector)
  const pairingRevision = requireCurrentPairing(initialEnvironment, options.expectedPairingRevision)
  const response = await options.getStatus(initialEnvironment.id)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const status = response.result
  if (status.runtimeId !== response._meta.runtimeId) {
    throw new Error('browser_client_host_runtime_identity_changed')
  }
  const environment = options.resolveEnvironment(initialEnvironment.id)
  requireCurrentPairing(environment, pairingRevision)
  if (status.deviceScope === 'mobile' || !supportsBrowserClientHosting(status.capabilities)) {
    return SERVER_PLACEMENT
  }
  if (status.graphStatus !== 'ready') {
    throw new Error('browser_client_host_runtime_not_ready')
  }

  const authority = await options.startHost({
    environment,
    authorityRuntimeId: status.runtimeId
  })
  const currentEnvironment = options.resolveEnvironment(initialEnvironment.id)
  try {
    requireCurrentPairing(currentEnvironment, pairingRevision)
    if (authority.authorityRuntimeId !== status.runtimeId) {
      throw new Error('browser_client_host_runtime_identity_changed')
    }
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error))
    await options.closeHost(initialEnvironment.id, reason).catch(() => false)
    throw reason
  }
  return Object.freeze({
    kind: 'client',
    browserHostClientId: authority.browserHostClientId
  })
}

function supportsBrowserClientHosting(capabilities: RuntimeStatus['capabilities']): boolean {
  return REQUIRED_RUNTIME_CAPABILITIES.every((capability) => capabilities?.includes(capability))
}

function requireCurrentPairing(
  environment: KnownRuntimeEnvironment,
  expectedRevision: number | undefined
): number {
  const revision = environment.pairingRevision ?? environment.createdAt
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new Error('browser_client_host_pairing_changed')
  }
  return revision
}

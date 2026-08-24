import { useEffect, useState } from 'react'
import { MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import type { ConnectionState } from '../transport/types'

export type MobileWebPackageCapabilityStatus =
  | 'offline'
  | 'pending'
  | 'supported'
  | 'update-required'

type ResolvedPackageCapability = {
  client: RpcClient
  hostId: string
  connectionId: number | null
  supported: boolean
}

function currentConnectionId(client: RpcClient): number | null {
  return typeof client.getLastConnectedAt === 'function' ? client.getLastConnectedAt() : null
}

export function useMobileWebPackageCapability(args: {
  client: RpcClient | null
  hostId: string | undefined
  state: ConnectionState
}): MobileWebPackageCapabilityStatus {
  const { client, hostId, state } = args
  const [resolved, setResolved] = useState<ResolvedPackageCapability | null>(null)

  useEffect(() => {
    if (state !== 'connected' || !client || !hostId) {
      return
    }
    const requestClient = client
    const requestHostId = hostId
    const requestConnectionId = currentConnectionId(requestClient)
    return startRuntimeCapabilityProbe(requestClient, (capabilities) => {
      setResolved({
        client: requestClient,
        hostId: requestHostId,
        connectionId: requestConnectionId,
        supported: capabilities.includes(MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY)
      })
    })
  }, [client, hostId, state])

  if (state !== 'connected') {
    return 'offline'
  }
  if (
    !client ||
    !hostId ||
    resolved?.client !== client ||
    resolved.hostId !== hostId ||
    resolved.connectionId !== currentConnectionId(client)
  ) {
    return 'pending'
  }
  return resolved.supported ? 'supported' : 'update-required'
}

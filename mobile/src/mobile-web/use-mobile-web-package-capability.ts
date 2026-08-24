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
  supported: boolean
}

export function useMobileWebPackageCapability(args: {
  client: RpcClient | null
  hostId: string | undefined
  state: ConnectionState
}): MobileWebPackageCapabilityStatus {
  const { client, hostId, state } = args
  const [resolved, setResolved] = useState<ResolvedPackageCapability | null>(null)
  const [unverified, setUnverified] = useState(true)

  useEffect(() => {
    if (state !== 'connected' || !client || !hostId) {
      setUnverified(true)
      return
    }
    const requestClient = client
    const requestHostId = hostId
    return startRuntimeCapabilityProbe(requestClient, (capabilities) => {
      setResolved({
        client: requestClient,
        hostId: requestHostId,
        supported: capabilities.includes(MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY)
      })
      setUnverified(false)
    })
  }, [client, hostId, state])

  if (state !== 'connected') {
    return 'offline'
  }
  if (
    !client ||
    !hostId ||
    unverified ||
    resolved?.client !== client ||
    resolved.hostId !== hostId
  ) {
    return 'pending'
  }
  return resolved.supported ? 'supported' : 'update-required'
}

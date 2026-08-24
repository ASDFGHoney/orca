import { useEffect, useRef, useState } from 'react'
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
  const verifiedConnectionRef = useRef<ResolvedPackageCapability | null>(null)

  if (state !== 'connected' || !client || !hostId) {
    verifiedConnectionRef.current = null
  }

  useEffect(() => {
    if (state !== 'connected' || !client || !hostId) {
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
      verifiedConnectionRef.current = {
        client: requestClient,
        hostId: requestHostId,
        supported: capabilities.includes(MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY)
      }
    })
  }, [client, hostId, state])

  if (state !== 'connected') {
    return 'offline'
  }
  if (
    !client ||
    !hostId ||
    verifiedConnectionRef.current?.client !== client ||
    verifiedConnectionRef.current.hostId !== hostId ||
    resolved?.client !== client ||
    resolved.hostId !== hostId
  ) {
    return 'pending'
  }
  return resolved.supported ? 'supported' : 'update-required'
}

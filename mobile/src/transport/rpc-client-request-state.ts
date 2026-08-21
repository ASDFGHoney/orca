import type { RpcResponse } from './types'

export type RpcPendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

export type RpcConnectWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

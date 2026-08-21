import type { TerminalStreamFrame } from './terminal-stream-protocol'
import type { RpcClientSubscribeOptions } from './rpc-client-subscribe-options'
import type { ConnectionState, ForegroundNudgeReason, RpcResponse } from './types'

export type RpcClientSendRequestOptions = {
  timeoutMs?: number
  /** Spend the timeout across connection wait and acknowledgement. */
  budgetSpansConnect?: boolean
  /** Reject immediately instead of replaying stale terminal input after reconnect. */
  failWhenDisconnected?: boolean
}

export type RpcClient = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: RpcClientSendRequestOptions
  ) => Promise<RpcResponse>
  subscribe: (
    method: string,
    params: unknown,
    onData: (result: unknown) => void,
    options?: RpcClientSubscribeOptions
  ) => () => void
  updateTerminalSubscriptionViewport: (
    terminal: string,
    viewport: { cols: number; rows: number }
  ) => void
  sendTerminalBinaryFrame: (frame: TerminalStreamFrame) => boolean
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  getLastConnectedAt: () => number | null
  getLastInboundAt?: () => number | null
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
  close: () => void
}

import {
  MobileWebSourceControlBranchComparePayloadSchema,
  type MobileWebSourceControlBranchComparePayload,
  type MobileWebSourceControlBranchCompareResult
} from '../../../src/shared/mobile-web/source-control-history-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { mobileWebEncodedByteLength } from './mobile-web-request-accounting'
import { sanitizeMobileWebBranchCompare } from './mobile-web-source-control-history-sanitizers'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const HOST_RESULT_MAX_BYTES = 8 * 1024 * 1024

type Continuation = {
  workspaceId: string
  baseRef: string
  revision: string
  nextOffset: number
  hostResult: unknown
}

export class MobileWebSourceControlBranchComparePager {
  private continuation: Continuation | null = null
  private claimed: Continuation | null = null
  private active = false

  claimRequestContinuation(request: {
    capability: string
    operation: string
    payload: unknown
  }): boolean {
    this.claimed = null
    return (
      request.capability === 'sourceControl' &&
      request.operation === 'branchCompare' &&
      this.claimContinuation(request.payload)
    )
  }

  claimContinuation(payloadValue: unknown): boolean {
    const parsed = MobileWebSourceControlBranchComparePayloadSchema.safeParse(payloadValue)
    const continuation = this.continuation
    if (!parsed.success || !parsed.data.expectedRevision || !continuation) {
      return false
    }
    const payload = parsed.data
    if (
      continuation.workspaceId !== payload.workspaceId ||
      continuation.baseRef !== payload.baseRef ||
      continuation.revision !== payload.expectedRevision ||
      continuation.nextOffset !== payload.offset
    ) {
      return false
    }
    this.continuation = null
    this.claimed = continuation
    return true
  }

  async page(
    payloadValue: unknown,
    client: RpcClient,
    workspaceAuthority: MobileWebWorkspaceAuthority
  ): Promise<MobileWebSourceControlBranchCompareResult> {
    if (this.active) {
      throw new MobileWebBrokerError('rate_limited')
    }
    this.active = true
    try {
      const payload = MobileWebSourceControlBranchComparePayloadSchema.parse(payloadValue)
      const hostResult = payload.expectedRevision
        ? this.consumeClaim(payload)
        : await this.begin(payload, client, workspaceAuthority)
      const page = sanitizeMobileWebBranchCompare(hostResult, payload)
      if (page.nextOffset !== null) {
        this.continuation = {
          workspaceId: payload.workspaceId,
          baseRef: payload.baseRef,
          revision: page.revision,
          nextOffset: page.nextOffset,
          hostResult
        }
      }
      return page
    } finally {
      this.active = false
      this.claimed = null
    }
  }

  clear(): void {
    this.continuation = null
    this.claimed = null
  }

  private async begin(
    payload: MobileWebSourceControlBranchComparePayload,
    client: RpcClient,
    workspaceAuthority: MobileWebWorkspaceAuthority
  ): Promise<unknown> {
    this.clear()
    if (payload.offset !== 0) {
      throw new MobileWebBrokerError('invalid_request')
    }
    const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await client.sendRequest('git.branchCompare', {
      worktree: `id:${hostWorkspaceId}`,
      baseRef: payload.baseRef
    })
    if (!response.ok) {
      throw new MobileWebBrokerError('host_error')
    }
    if (mobileWebEncodedByteLength(response.result) > HOST_RESULT_MAX_BYTES) {
      throw new MobileWebBrokerError('too_large')
    }
    return response.result
  }

  private consumeClaim(payload: MobileWebSourceControlBranchComparePayload): unknown {
    const continuation = this.claimed
    if (!continuation) {
      throw new MobileWebBrokerError('invalid_request')
    }
    if (continuation.revision !== payload.expectedRevision) {
      throw new MobileWebBrokerError('conflict')
    }
    if (
      continuation.workspaceId !== payload.workspaceId ||
      continuation.baseRef !== payload.baseRef ||
      continuation.nextOffset !== payload.offset
    ) {
      throw new MobileWebBrokerError('invalid_request')
    }
    return continuation.hostResult
  }
}

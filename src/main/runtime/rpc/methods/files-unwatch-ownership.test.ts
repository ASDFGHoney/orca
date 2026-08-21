import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { FILE_METHODS } from './files'

describe('files.unwatch ownership', () => {
  it('refuses teardown when the socket does not own the subscription', async () => {
    const cleanupSubscriptionIfOwnedByConnection = vi.fn().mockReturnValue(false)
    const cleanupSubscriptionAndWait = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cleanupSubscriptionIfOwnedByConnection,
      cleanupSubscriptionAndWait
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'files.unwatch',
      params: { subscriptionId: 'files-watch-conn-owner-1' }
    }
    const replies: unknown[] = []

    await dispatcher.dispatchStreaming(request, (reply) => replies.push(JSON.parse(reply)), {
      connectionId: 'conn-attacker'
    })

    expect(cleanupSubscriptionIfOwnedByConnection).toHaveBeenCalledWith(
      'files-watch-conn-owner-1',
      'conn-attacker'
    )
    expect(cleanupSubscriptionAndWait).not.toHaveBeenCalled()
    expect(replies).toEqual([expect.objectContaining({ result: { unsubscribed: false } })])
  })
})

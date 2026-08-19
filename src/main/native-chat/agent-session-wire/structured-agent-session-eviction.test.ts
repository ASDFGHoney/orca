import { describe, expect, it, vi } from 'vitest'
import {
  evictStructuredAgentSession,
  StructuredAgentSessionEvictionError,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'

function context(): StructuredAgentSessionEvictionContext & { order: string[] } {
  const order: string[] = []
  return {
    order,
    sessionId: 'session-1',
    eventSink: {
      unbind: vi.fn(() => order.push('unbind')),
      drained: vi.fn(async () => {
        order.push('drained')
      }),
      close: vi.fn(() => order.push('close'))
    } as unknown as StructuredAgentSessionEvictionContext['eventSink'],
    adapter: {
      closeSession: vi.fn(async () => {
        order.push('closeSession')
      })
    } as unknown as StructuredAgentSessionEvictionContext['adapter'],
    forget: vi.fn(() => order.push('forget'))
  }
}

describe('structured agent session eviction', () => {
  // Order is the correctness property: draining after the child is gone discards rows the provider
  // already sent, and forgetting before it stops strands the process.
  it('drains what the session produced, then stops the child, then forgets it', async () => {
    const ctx = context()
    await evictStructuredAgentSession(ctx)
    expect(ctx.order).toEqual(['unbind', 'drained', 'close', 'closeSession', 'forget'])
  })

  it('names every step, so a half-finished eviction says which one failed', () => {
    expect(STRUCTURED_AGENT_SESSION_EVICTION_STEPS.map((step) => step.name)).toEqual([
      'stop-publishing',
      'drain-published',
      'close-sink',
      'stop-provider-child',
      'forget-session'
    ])
  })

  // A child that refuses to stop must not also leave the session wired to a dead sink.
  it('runs the remaining steps when one fails, and reports which failed', async () => {
    const ctx = context()
    ctx.adapter.closeSession = vi.fn(async () => {
      throw new Error('child would not stop')
    })

    await expect(evictStructuredAgentSession(ctx)).rejects.toBeInstanceOf(
      StructuredAgentSessionEvictionError
    )
    await expect(evictStructuredAgentSession(ctx)).rejects.toMatchObject({
      step: 'stop-provider-child',
      sessionId: 'session-1'
    })
    expect(ctx.forget).toHaveBeenCalled()
  })
})

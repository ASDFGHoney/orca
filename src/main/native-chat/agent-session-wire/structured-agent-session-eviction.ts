// Releasing one structured session's resources.
//
// Teardown is a DATA list, not a method body, for the reason this file exists at all: the host
// tracked which sessions were live in a map, and tore them down at three unrelated call sites
// (app quit, handoff to a TUI, and error cleanup). Closing a chat was never wired to any of them,
// so a provider child outlived the chat that owned it for the whole app session.
//
// A list makes the next way a session can end cheap to support — add a caller, not a fourth
// teardown — and makes a half-finished eviction say WHICH step failed instead of failing opaquely.
// Order matters and is asserted by name in the tests: drain what the session already produced
// before stopping its child, and stop the child before forgetting it. Draining after the child is
// gone discards rows the provider already sent; forgetting first strands the process.

import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'

export type StructuredAgentSessionEvictionContext = {
  sessionId: string
  eventSink: DeferredStructuredAgentSessionEventSink
  adapter: StructuredAgentSessionAdapter
  forget: () => void
}

export type StructuredAgentSessionEvictionStep = {
  name: string
  run: (context: StructuredAgentSessionEvictionContext) => Promise<void> | void
}

export const STRUCTURED_AGENT_SESSION_EVICTION_STEPS: readonly StructuredAgentSessionEvictionStep[] =
  [
    { name: 'stop-publishing', run: (context) => context.eventSink.unbind() },
    { name: 'drain-published', run: (context) => context.eventSink.drained() },
    { name: 'close-sink', run: (context) => context.eventSink.close() },
    {
      name: 'stop-provider-child',
      run: async (context) => {
        await context.adapter.closeSession?.(context.sessionId)
      }
    },
    { name: 'forget-session', run: (context) => context.forget() }
  ]

export class StructuredAgentSessionEvictionError extends Error {
  constructor(
    readonly step: string,
    readonly sessionId: string,
    override readonly cause: unknown
  ) {
    super(`agent session eviction failed at step "${step}" for ${sessionId}`)
    this.name = 'StructuredAgentSessionEvictionError'
  }
}

/**
 * Runs every eviction step in order. A failing step is reported with its name and does NOT skip the
 * rest: a child that refuses to stop must not also leave the session wired to a dead sink.
 */
export async function evictStructuredAgentSession(
  context: StructuredAgentSessionEvictionContext,
  steps: readonly StructuredAgentSessionEvictionStep[] = STRUCTURED_AGENT_SESSION_EVICTION_STEPS
): Promise<void> {
  let failure: StructuredAgentSessionEvictionError | null = null
  for (const step of steps) {
    try {
      await step.run(context)
    } catch (error) {
      failure ??= new StructuredAgentSessionEvictionError(step.name, context.sessionId, error)
    }
  }
  if (failure) {
    throw failure
  }
}

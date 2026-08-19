// The attach orchestration, lifted out of the host.
//
// The host is a coordinator: it serializes work per session and tracks in-flight attaches. THIS is
// the part that decides what attaching means — reconcile the lease, resolve any pending recovery,
// bind an event sink, and publish the right thing to subscribers depending on whether the journal
// was recovered, re-fenced, or unchanged. Keeping it here means the host file stays a surface
// rather than an implementation, and this sequence can be read without scrolling past everything
// else a session can do.

import { randomUUID } from 'node:crypto'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { performAttach } from './structured-agent-session-attach-flow'
import { pinnedAgentSessionLaunchEnv } from './structured-agent-session-launch-env'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'

export async function attachStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  const unreconciled = await context.reconcileLeases(sessionId)
  if (unreconciled) {
    return refuseAgentSessionMutation(unreconciled)
  }
  await context.runtimeState.resolveRecovery(sessionId)
  const eventSink = context.runtimeState.eventSinkFor(sessionId)
  const attached = await performAttach({
    store: context.deps.store,
    adapter: context.deps.adapter,
    journalRoot: context.deps.journalRoot,
    eventSink: eventSink.sink,
    onAcquiring: () => eventSink.unbind(),
    beforeJournalOpen: async () => {
      eventSink.unbind()
      await eventSink.drained()
    },
    authority: {
      spawnToken: context.deps.mintSpawnToken?.() ?? randomUUID(),
      claimKeyId: context.deps.claimKeyId,
      handoffOperationId: params.envelope.clientOperationId,
      probe: await context.runtimeState.probeOwner(sessionId),
      ...(await pinnedAgentSessionLaunchEnv(context.deps.resolveLaunchEnv, params))
    },
    callerKey,
    params,
    now: () => context.now(),
    onAttached: (attached) => {
      const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
      const previousFence = context.sessions.get(sessionId)?.fence
      context.sessions.set(sessionId, { journal: attached.journal, params, fence })
      if (attached.recovery) {
        context.subscribers.reset(sessionId, attached.journal, attached.recovery.reset, fence)
      } else if (previousFence !== undefined && previousFence !== fence) {
        context.subscribers.snapshot(sessionId, attached.journal, fence)
      } else {
        context.subscribers.publish(sessionId, attached.journal)
      }
      eventSink.bind({
        journal: attached.journal,
        fence,
        publish: () => context.subscribers.publish(sessionId, attached.journal)
      })
    }
  })
  if (!attached.ok && !context.sessions.has(sessionId)) {
    eventSink.close()
    context.runtimeState.discardEventSink(sessionId)
  }
  return attached
}

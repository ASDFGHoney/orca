import { isDeepStrictEqual } from 'node:util'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import {
  admitAttachOrRefuse,
  attachJournal,
  reserveRequestFor
} from './structured-agent-session-attach'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredTuiOwner } from './structured-agent-session-handoff-types'
import { isStructuredTuiAdoptionReservation } from './structured-agent-session-tui-adoption-reservation'

export type StructuredTuiAdoptionRequest = {
  caller: StructuredAgentSessionCaller
  params: AgentSessionAttachParams
  owner: StructuredTuiOwner
  claimKeyId: string
  launchEnv?: Record<string, string>
}

export function adoptStructuredTuiOwner(
  input: StructuredTuiAdoptionRequest & {
    deps: StructuredAgentSessionHostDeps
    now: () => number
    publish: (sessionId: string, session: StructuredAgentSessionHostSession) => void
    retain: (sessionId: string, owner: StructuredTuiOwner) => void
    snapshot: (sessionId: string, session: StructuredAgentSessionHostSession) => void
  }
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return adopt(input)
}

async function adopt(
  input: Parameters<typeof adoptStructuredTuiOwner>[0]
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { params, owner } = input
  const sessionId = params.envelope.sessionId
  const admitted = admitAttachOrRefuse(params)
  if (!admitted.ok) {
    return admitted
  }
  let record = input.deps.store.getRecord(sessionId)
  let replayed = record !== null
  if (record && isStructuredTuiAdoptionReservation(record, owner.process.spawnToken)) {
    // This adoption's own pre-proof reservation: turn it into an owner rather than reserve again.
    replayed = false
    record = await proveAdoptedTuiOwner(input, record)
  } else if (record) {
    assertMatchingTuiOwner(record, owner)
  } else {
    const reserved = await input.deps.store.reserveOwner(
      reserveRequestFor({
        sessionId,
        params,
        authority: {
          spawnToken: owner.process.spawnToken,
          claimKeyId: input.claimKeyId,
          handoffOperationId: params.envelope.clientOperationId,
          probe: { outcome: 'reservation-unused' },
          ...(input.launchEnv ? { launchEnv: input.launchEnv } : {})
        },
        callerKey: input.caller.callerKey,
        fingerprint: admitted.fingerprint,
        now: input.now()
      })
    )
    replayed = reserved.disposition === 'replayed'
    record = await proveAdoptedTuiOwner(input, reserved.record)
  }
  const attached = await attachJournal({
    record,
    params,
    journalRoot: input.deps.journalRoot,
    adapter: input.deps.adapter
  })
  // The TUI owns the process here; this host publishes the journal only.
  const session = {
    journal: attached.journal,
    params,
    fence: record.lease.runtimeFence,
    hasProviderChild: false
  }
  input.publish(sessionId, session)
  input.retain(sessionId, owner)
  input.snapshot(sessionId, session)
  await input.deps.store.recordOperationOutcome({
    callerKey: input.caller.callerKey,
    operationId: params.envelope.clientOperationId,
    outcome: { status: 'succeeded', sessionId }
  })
  return {
    ok: true,
    replayed,
    fence: record.lease.runtimeFence,
    cursor: attached.journal.cursor(),
    value: {
      sessionId,
      fence: record.lease.runtimeFence,
      snapshot: attached.journal.snapshot(),
      unconfirmedClientMessageIds: attached.unconfirmedClientMessageIds
    }
  }
}

/** Steps 4 and 5 of acquisition against a reservation that already exists at this fence. */
async function proveAdoptedTuiOwner(
  input: Parameters<typeof adoptStructuredTuiOwner>[0],
  record: AgentSessionRecord
): Promise<AgentSessionRecord> {
  const { sessionId } = record
  const fence = record.lease.runtimeFence
  await input.deps.store.commitProcessIdentity({
    sessionId,
    fence,
    process: input.owner.process,
    now: input.now()
  })
  return input.deps.store.proveOwner({
    sessionId,
    fence,
    link: input.owner.link,
    now: input.now()
  })
}

function assertMatchingTuiOwner(
  record: NonNullable<ReturnType<StructuredAgentSessionHostDeps['store']['getRecord']>>,
  owner: StructuredTuiOwner
): void {
  const head = record.providerHandleChain.at(-1)?.handle
  const adopted = owner.link.handle
  if (
    record.lease.runtimeKind !== 'tui' ||
    record.lease.claimStatus !== 'live' ||
    !isDeepStrictEqual(record.lease.ownerProcess, owner.process) ||
    head?.provider !== 'codex' ||
    adopted.provider !== 'codex' ||
    head.threadId !== adopted.threadId
  ) {
    throw new Error('agent_session_conflict')
  }
}

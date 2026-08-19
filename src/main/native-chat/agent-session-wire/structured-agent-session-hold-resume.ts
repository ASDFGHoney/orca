// Giving a held session its provider child back.
//
// This is the replacement for the startup resume, and the difference is only in WHO asks: the same
// eligibility rule, run when a surface binds instead of when the app launches. A refusal is not an
// error here — the surface still holds the session and can still read it; it just cannot send until
// the lease frees up — so this resolves either way and leaves the refusal to the read path.

import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import {
  structuredAgentSessionResumeOperationId,
  structuredAgentSessionResumeParams
} from './structured-agent-session-resume-eligibility'

export async function resumeHeldStructuredAgentSession(input: {
  sessionId: string
  deps: StructuredAgentSessionHostDeps
  now: () => number
  attach: (params: AgentSessionAttachParams) => Promise<{ ok: boolean }>
}): Promise<void> {
  const record = input.deps.store.getRecord(input.sessionId)
  if (!record || !adapterSupportsRecord(input.deps.adapter, record)) {
    return
  }
  const params = structuredAgentSessionResumeParams(
    record,
    structuredAgentSessionResumeOperationId(input.now())
  )
  if (!params) {
    return
  }
  await input.attach(params)
}

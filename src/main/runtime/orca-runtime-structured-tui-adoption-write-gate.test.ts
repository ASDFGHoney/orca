/**
 * Adoption against the REAL `agentSessionPtyWriteGate`.
 *
 * Every other adoption test mocks the PTY controller, so `writeAgentSessionProof` answers whatever
 * the mock says and `admitProof` never runs — which is precisely why they all passed while no user
 * could ever switch a Codex tab to structured chat. Here the controller delegates to the real gate
 * over a real record store, so the probe is admitted only when adoption has actually reserved the
 * lease and bound the pane first.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { createStructuredAgentSessionOwnerProbe } from './structured-agent-session-runtime'
import { OrcaRuntimeService } from './orca-runtime'

const { readStructuredTuiProcessIdentity } = vi.hoisted(() => ({
  readStructuredTuiProcessIdentity: vi.fn()
}))
// The only OS-dependent step in the flow; the rollout proof and the write gate both stay real.
vi.mock('./structured-tui-process-identity', () => ({ readStructuredTuiProcessIdentity }))

const WORKTREE_ID = 'repo-1::/tmp/structured-adoption'
const PTY_ID = 'pty-adopt'
const PANE_KEY = 'tab-adopt:leaf-adopt'
const THREAD_ID = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
const SESSION_ID = `codex_${THREAD_ID.replaceAll('-', '_')}`

type ProofRig = {
  runtime: OrcaRuntimeService
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  proofWrites: string[]
  refusedWrites: string[]
  codexHome: string
}

let root: string
let rig: ProofRig

async function writeRolloutFixture(codexHome: string, threadId: string): Promise<void> {
  const dir = join(codexHome, 'sessions', '2026', '08', '19')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `rollout-2026-08-19T10-00-00-${threadId}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`,
    'utf8'
  )
}

/**
 * A PTY that answers `/status` with a Codex session banner — but only for bytes the real gate
 * admitted. This mirrors `writeAgentSessionProof` in src/main/ipc/pty.ts verbatim.
 */
function installProofPty(
  rigState: ProofRig,
  threadId: string,
  ptyRecord: { lastOutputAt: number }
) {
  return (ptyId: string, data: string, authority: { sessionId: string; spawnToken: string }) => {
    if (!agentSessionPtyWriteGate.admitProof(ptyId, authority)) {
      rigState.refusedWrites.push(data)
      return false
    }
    rigState.proofWrites.push(data)
    if (data === '\r') {
      const record = rigState.runtime as unknown as {
        ptysById: Map<string, { tailBuffer: string[]; lastOutputAt: number }>
      }
      const pty = record.ptysById.get(PTY_ID)!
      pty.tailBuffer = [`Session ID: ${threadId}`]
      pty.lastOutputAt = ptyRecord.lastOutputAt + 1_000
    }
    return true
  }
}

async function buildRig(): Promise<ProofRig> {
  const codexHome = join(root, 'codex-home')
  await writeRolloutFixture(codexHome, THREAD_ID)
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'agent-sessions'),
    hostId: 'local'
  })
  agentSessionPtyWriteGate.attachRecordLookup((sessionId) => store.getRecord(sessionId))
  const host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalRoot: join(root, 'journals'),
    claimKeyId: 'key-1',
    probeOwner: createStructuredAgentSessionOwnerProbe(
      'local',
      async () => ({ outcome: 'identity-matched', matchedOn: ['process-start-time'] }),
      async () => []
    )
  })
  setStructuredAgentSessionHost(host)

  const runtime = new OrcaRuntimeService({ getSettings: () => ({ agentDefaultEnv: {} }) } as never)
  const state: ProofRig = { runtime, store, host, proofWrites: [], refusedWrites: [], codexHome }
  const ptyRecord = {
    ptyId: PTY_ID,
    connected: true,
    connectionId: null,
    wslDistro: null,
    tabId: 'tab-adopt',
    paneKey: PANE_KEY,
    worktreeId: WORKTREE_ID,
    incarnationId: 'inc-adopt',
    tailBuffer: [] as string[],
    tailPartialLine: '',
    preview: '',
    lastOutputAt: 1_000
  }
  const internal = runtime as unknown as {
    ptysById: Map<string, unknown>
    resolveRuntimeFileTarget(): Promise<unknown>
    resolveStructuredAgentSessionAdoptionIntent(input: { envelope: unknown }): Promise<unknown>
    issueStructuredTuiPtyHandle(): string
  }
  internal.ptysById.set(PTY_ID, ptyRecord)
  internal.resolveRuntimeFileTarget = vi.fn(async () => ({
    connectionId: null,
    worktree: { id: WORKTREE_ID }
  }))
  // Why the adoption intent and not the create one: adoption resolves the pane's OWN account
  // home, which this rig has no pane-account record for. The pane-home resolution itself is
  // covered by orca-runtime-structured-tui-adoption-account-home.test.ts.
  internal.resolveStructuredAgentSessionAdoptionIntent = vi.fn(async ({ envelope }) => ({
    envelope,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKTREE_ID,
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: codexHome },
    runtimeKind: 'native'
  }))
  internal.issueStructuredTuiPtyHandle = vi.fn(() => 'term-adopt')
  runtime.setPtyController({
    listProcesses: async () => [{ id: PTY_ID, incarnationId: 'inc-adopt', rootProcessId: 31337 }],
    writeAgentSessionProof: installProofPty(state, THREAD_ID, ptyRecord)
  } as never)
  return state
}

function adoptInput(overrides: { threadId?: string } = {}) {
  return {
    envelope: {
      sessionId: SESSION_ID,
      clientOperationId: createStructuredAgentSessionOperationId(() => randomUUID()),
      expectedRuntimeFence: null as null,
      payloadFingerprint: 'a'.repeat(64)
    },
    worktree: `id:${WORKTREE_ID}`,
    tabId: 'tab-adopt',
    paneKey: PANE_KEY,
    ptyId: PTY_ID,
    ...overrides
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-adopt-gate-'))
  readStructuredTuiProcessIdentity.mockImplementation(
    async (input: { hostId: string; spawnToken: string }) => ({
      hostId: input.hostId,
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: input.spawnToken
    })
  )
  rig = await buildRig()
})

afterEach(async () => {
  agentSessionPtyWriteGate.unbindPty(PTY_ID)
  agentSessionPtyWriteGate.detachRecordLookup()
  setStructuredAgentSessionHost(null)
  await rig.host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('structured Codex adoption against the real PTY write gate', () => {
  it('authorizes the provider probe, so switching a Codex tab to chat succeeds', async () => {
    const result = await rig.runtime.adoptStructuredAgentSessionTerminal(
      { ...adoptInput(), threadId: THREAD_ID },
      { callerKey: 'renderer-1' }
    )

    expect(result).toMatchObject({ ok: true })
    // The probe reached the pane: `/status`, submit, escape — none of them refused by the gate.
    expect(rig.refusedWrites).toEqual([])
    expect(rig.proofWrites).toHaveLength(3)
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      lease: { runtimeKind: 'tui', claimStatus: 'live', handoffStage: null }
    })
  }, 20_000)

  it('authorizes the probe when no thread id has been published yet', async () => {
    const result = await rig.runtime.adoptStructuredAgentSessionTerminal(adoptInput(), {
      callerKey: 'renderer-1'
    })

    expect(result).toMatchObject({ ok: true })
    expect(rig.refusedWrites).toEqual([])
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      providerHandleChain: [{ origin: 'adopted', handle: { threadId: THREAD_ID } }]
    })
  }, 20_000)

  it('leaves nothing latched when the proof fails, so the next attempt still succeeds', async () => {
    await rm(join(rig.codexHome, 'sessions'), { recursive: true, force: true })

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(
        { ...adoptInput(), threadId: THREAD_ID },
        { callerKey: 'renderer-1' }
      )
    ).rejects.toThrow('did not prove the expected Codex rollout')
    // The reservation is durably marked as never having spawned, and the pane is released.
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBeNull()
    expect(rig.store.getRecord(SESSION_ID)?.lease).toMatchObject({
      claimStatus: 'reserved',
      ownerProcess: null
    })
    expect(rig.store.getRecord(SESSION_ID)?.lease.processlessAt).toEqual(expect.any(Number))

    await writeRolloutFixture(rig.codexHome, THREAD_ID)
    const retried = await rig.runtime.adoptStructuredAgentSessionTerminal(
      { ...adoptInput(), threadId: THREAD_ID },
      { callerKey: 'renderer-1' }
    )

    expect(retried).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      lease: { claimStatus: 'live', runtimeKind: 'tui' }
    })
  }, 30_000)

  it('lets the attempt holding the reservation win when two adoptions overlap', async () => {
    // Both attempts park here: reservation taken and pane bound, proof not yet written.
    const arrived: string[] = []
    let releaseBoth: () => void = () => {}
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    readStructuredTuiProcessIdentity.mockImplementation(
      async (input: { hostId: string; spawnToken: string }) => {
        if (!arrived.includes(input.spawnToken)) {
          arrived.push(input.spawnToken)
          if (arrived.length === 2) {
            releaseBoth()
          }
          await bothArrived
        }
        return {
          hostId: input.hostId,
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken: input.spawnToken
        }
      }
    )

    const superseded = rig.runtime.adoptStructuredAgentSessionTerminal(
      { ...adoptInput(), threadId: THREAD_ID },
      { callerKey: 'renderer-1' }
    )
    superseded.catch(() => undefined)
    await vi.waitFor(() => expect(arrived).toHaveLength(1))
    // The second attempt carries the same sessionId and supersedes the first one's reservation.
    const winner = rig.runtime.adoptStructuredAgentSessionTerminal(
      { ...adoptInput(), threadId: THREAD_ID },
      { callerKey: 'renderer-1' }
    )

    await expect(winner).resolves.toMatchObject({ ok: true })
    await expect(superseded).rejects.toThrow('could not verify its Codex session')
    // The loser's cleanup ran against a pane and a reservation that were no longer its own.
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      lease: { runtimeKind: 'tui', claimStatus: 'live', handoffStage: null }
    })
  }, 30_000)

  it('refuses a pane another structured session already owns', async () => {
    agentSessionPtyWriteGate.bindPty(PTY_ID, 'someone-elses-session')

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(
        { ...adoptInput(), threadId: THREAD_ID },
        { callerKey: 'renderer-1' }
      )
    ).rejects.toThrow('already belongs to another structured Codex session')
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe('someone-elses-session')
    expect(rig.store.getRecord(SESSION_ID)).toBeNull()
  })
})

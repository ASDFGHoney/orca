import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { setStoredAgentSessionHandoffStage } from '../../runtime/agent-session-handoff-record-transitions'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionHandoffCoordinator } from './structured-agent-session-handoff'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

const NOW = 1_800_000_000_000
const SESSION = 'session-handoff-failure-injection'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'folder' as const
} satisfies AgentSessionExecutionLocation

let root: string
let store: AgentSessionRecordStore
let journal: Awaited<ReturnType<typeof openAgentSessionJournal>>
let coordinator: StructuredAgentSessionHandoffCoordinator
let launchTui: Mock<StructuredAgentSessionHandoffTransport['launchTui']>
let reproveTuiOwner: Mock<StructuredAgentSessionHandoffTransport['reproveTuiOwner']>
let closeTuiOwner: Mock<NonNullable<StructuredAgentSessionHandoffTransport['closeTuiOwner']>>
let stopRecoveredOwner: Mock<StructuredAgentSessionHandoffTransport['stopRecoveredOwner']>
let suspendNative: Mock<(sessionId: string) => Promise<void | boolean>>
let acquireNativeStop: Mock<(turnId: string) => Promise<boolean>>
let acquireNativeCalls: number

function operationId(sequence: number): string {
  return `${NOW}-${sequence.toString(16).padStart(32, '0')}`
}

function providerLink(fence: number) {
  return {
    linkId: `link-${fence}`,
    handle: { provider: 'codex' as const, threadId: THREAD },
    origin: 'resumed' as const,
    mintedAtFence: fence,
    observedAt: NOW
  }
}

function processIdentity(spawnToken: string, pid: number) {
  return { hostId: 'local', pid, processStartTimeMs: NOW - 1_000, spawnToken }
}

function tuiOwner(fence: number, spawnToken: string, transcriptPath?: string): StructuredTuiOwner {
  return {
    terminal: {
      handle: 'term-tui',
      tabId: 'tab-tui',
      paneKey: 'tab-tui:leaf-tui',
      ptyId: 'pty-tui'
    },
    process: processIdentity(spawnToken, 4200),
    link: providerLink(fence),
    ...(transcriptPath ? { transcriptPath } : {}),
    historySource: 'provider-resume'
  }
}

function handoff(
  direction: 'to-native' | 'to-tui',
  mode: 'now' | 'stop-turn',
  sequence: number
): AgentSessionHandoffRequest {
  const fields = { direction, mode, action: 'start' as const }
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(sequence),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.requestHandoff',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  }
}

async function establishNativeOwner(): Promise<void> {
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: LOCATION,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'native-spawn',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'test', operationId: operationId(1), fingerprint: 'create' },
    now: NOW
  })
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence: reserved.record.lease.runtimeFence,
    process: processIdentity('native-spawn', 4100),
    now: NOW
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence: reserved.record.lease.runtimeFence,
    link: { ...providerLink(reserved.record.lease.runtimeFence), origin: 'created' },
    now: NOW
  })
}

async function appendRunningTurn(): Promise<void> {
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'turn-status' },
    { kind: 'status', text: 'running', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
    { fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1 }
  )
}

function createCoordinator(): void {
  coordinator = new StructuredAgentSessionHandoffCoordinator({
    store,
    claimKeyId: 'key-1',
    transport: {
      hostLabel: 'Test host',
      launchTui,
      reproveTuiOwner,
      closeTuiOwner,
      waitForTuiExit: vi.fn<StructuredAgentSessionHandoffTransport['waitForTuiExit']>(
        async () => ({})
      ),
      waitForTuiIdleOrExit: vi.fn<StructuredAgentSessionHandoffTransport['waitForTuiIdleOrExit']>(
        async () => 'idle'
      ),
      tuiStatus: () => 'idle',
      recoverTuiOwner: vi.fn<StructuredAgentSessionHandoffTransport['recoverTuiOwner']>(
        async (record) =>
          tuiOwner(
            record.lease.runtimeFence,
            record.lease.ownerProcess?.spawnToken ?? 'recovered',
            join(root, 'rollout.jsonl')
          )
      ),
      probeRecoveredOwner: async () => 'dead',
      stopRecoveredOwner
    } satisfies StructuredAgentSessionHandoffTransport,
    session: () => ({
      journal,
      fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1
    }),
    suspendNative,
    acquireNative: async ({ fence, spawnToken }) => {
      acquireNativeCalls += 1
      await store.commitProcessIdentity({
        sessionId: SESSION,
        fence,
        process: processIdentity(spawnToken, 4300 + acquireNativeCalls),
        now: NOW
      })
      return store.proveOwner({
        sessionId: SESSION,
        fence,
        link: providerLink(fence),
        now: NOW
      })
    },
    acquireNativeStop: (_sessionId, turnId) => acquireNativeStop(turnId),
    importTuiHistory: vi.fn(),
    publish: vi.fn(),
    schedule: async (_sessionId, task) => task(),
    now: () => NOW
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-handoff-failure-injection-'))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: join(root, 'journal')
  })
  launchTui = vi.fn<StructuredAgentSessionHandoffTransport['launchTui']>(
    async ({ fence, spawnToken }) => tuiOwner(fence, spawnToken)
  )
  reproveTuiOwner = vi.fn<StructuredAgentSessionHandoffTransport['reproveTuiOwner']>(
    async ({ owner }) => owner
  )
  closeTuiOwner = vi.fn<NonNullable<StructuredAgentSessionHandoffTransport['closeTuiOwner']>>(
    async (owner) => ({ transcriptPath: owner.transcriptPath })
  )
  stopRecoveredOwner = vi.fn<StructuredAgentSessionHandoffTransport['stopRecoveredOwner']>(
    async () => undefined
  )
  suspendNative = vi.fn(async () => undefined)
  acquireNativeStop = vi.fn<(turnId: string) => Promise<boolean>>(async () => true)
  acquireNativeCalls = 0
  await establishNativeOwner()
  createCoordinator()
})

afterEach(async () => {
  await coordinator.drain()
  await rm(root, { recursive: true, force: true })
})

describe('structured handoff failure injection', () => {
  it('leaves the native owner and preparing checkpoint when provider close fails', async () => {
    suspendNative.mockRejectedValueOnce(new Error('durable handle unavailable'))

    expect(await coordinator.request('client-1', handoff('to-tui', 'now', 2))).toMatchObject({
      ok: true
    })
    await coordinator.drain()

    expect(launchTui).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: 'preparing',
      handoffOperationId: expect.any(String)
    })
    expect(coordinator.status(SESSION)).toMatchObject({
      owner: 'native',
      phase: 'failed',
      error: { recoverableOwner: 'native' }
    })
  })

  it('keeps the native owner when cancellation is not acknowledged', async () => {
    await appendRunningTurn()
    acquireNativeStop.mockResolvedValueOnce(false)

    expect(await coordinator.request('client-1', handoff('to-tui', 'stop-turn', 2))).toMatchObject({
      ok: true
    })
    await coordinator.drain()

    expect(acquireNativeStop).toHaveBeenCalledWith('turn-1')
    expect(launchTui).not.toHaveBeenCalled()
    expect(coordinator.status(SESSION)).toMatchObject({
      owner: 'native',
      phase: 'failed',
      error: { recoverableOwner: 'native' }
    })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null,
      handoffOperationId: null
    })
  })

  it('discovers a rollout created after the first TUI launch', async () => {
    let rolloutPath: string | undefined
    launchTui.mockImplementationOnce(async ({ fence, spawnToken }) => {
      const owner = tuiOwner(fence, spawnToken)
      const { transcriptPath: _notYetWritten, ...blank } = owner
      return blank
    })
    reproveTuiOwner.mockImplementation(async ({ owner }) => ({
      ...owner,
      ...(rolloutPath ? { transcriptPath: rolloutPath } : {})
    }))

    expect(await coordinator.request('client-1', handoff('to-tui', 'now', 2))).toMatchObject({
      ok: true
    })
    await coordinator.drain()
    expect(coordinator.status(SESSION)).toMatchObject({ owner: 'tui', phase: 'idle' })

    // The first TUI was blank; a prompt creates the durable rollout before the reverse proof.
    rolloutPath = join(root, 'rollout-created-by-prompt.jsonl')
    expect(await coordinator.request('client-1', handoff('to-native', 'now', 3))).toMatchObject({
      ok: true
    })
    await coordinator.drain()

    expect(closeTuiOwner).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null
    })
  })

  it('recovers a dead TUI recorded during preparing before acquiring native', async () => {
    expect(await coordinator.request('client-1', handoff('to-tui', 'now', 2))).toMatchObject({
      ok: true
    })
    await coordinator.drain()
    const current = store.getRecord(SESSION)!
    await setStoredAgentSessionHandoffStage(store, {
      sessionId: SESSION,
      fence: current.lease.runtimeFence,
      stage: 'preparing',
      handoffOperationId: operationId(4),
      now: NOW
    })
    reproveTuiOwner.mockRejectedValueOnce(new Error('TUI exited during restart'))
    createCoordinator()

    await coordinator.restore(SESSION)

    expect(stopRecoveredOwner).toHaveBeenCalledOnce()
    expect(acquireNativeCalls).toBe(1)
    expect(coordinator.status(SESSION)).toMatchObject({ owner: 'native', phase: 'idle' })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null
    })
  })

  it('abandons a dead TUI recorded during new-owner proving before relaunching', async () => {
    expect(await coordinator.request('client-1', handoff('to-tui', 'now', 2))).toMatchObject({
      ok: true
    })
    await coordinator.drain()
    const current = store.getRecord(SESSION)!
    await setStoredAgentSessionHandoffStage(store, {
      sessionId: SESSION,
      fence: current.lease.runtimeFence,
      stage: 'new-owner-proving',
      handoffOperationId: operationId(4),
      now: NOW
    })
    reproveTuiOwner.mockRejectedValueOnce(new Error('new TUI owner exited'))
    createCoordinator()

    await coordinator.restore(SESSION)

    expect(stopRecoveredOwner).toHaveBeenCalledOnce()
    expect(launchTui).toHaveBeenCalledTimes(2)
    expect(coordinator.status(SESSION)).toMatchObject({ owner: 'tui', phase: 'idle' })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'tui',
      claimStatus: 'live',
      handoffStage: null
    })
  })
})

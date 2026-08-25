import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'

const identity = (agent: 'codex' | 'claude'): AgentSessionJournalIdentity => ({
  sessionId: `${agent}-session`,
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent,
  providerHandle:
    agent === 'codex'
      ? { kind: 'codex', threadId: 'thread-1' }
      : { kind: 'claude', sessionId: 'session-1', leafUuid: null }
})

function adapter(
  closeSession?: StructuredAgentSessionAdapter['closeSession']
): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn<StructuredAgentSessionAdapter['acquire']>(async ({ fence, spawnToken }) => ({
      process: { hostId: 'local', pid: 42, processStartTimeMs: 1, spawnToken },
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex' as const, threadId: 'thread-1' },
        origin: 'created' as const,
        mintedAtFence: fence,
        observedAt: 1
      }
    })),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn(),
    ...(closeSession ? { closeSession } : {})
  }
}

describe('StructuredAgentSessionAdapterRouter.closeSession', () => {
  it('routes shutdown to the adapter that acquired the session', async () => {
    const closeCodex = vi.fn(async () => true)
    const closeClaude = vi.fn(async () => true)
    const codex = adapter(closeCodex)
    const claude = adapter(closeClaude)
    const router = new StructuredAgentSessionAdapterRouter({ codex, claude }, async () => undefined)

    await router.acquire({ identity: identity('codex'), fence: 1, spawnToken: 'spawn-codex' })
    await router.acquire({ identity: identity('claude'), fence: 1, spawnToken: 'spawn-claude' })

    await expect(router.closeSession('codex-session')).resolves.toBe(true)
    expect(closeCodex).toHaveBeenCalledWith('codex-session')
    expect(closeClaude).not.toHaveBeenCalled()
  })

  it('refuses shutdown when the owner cannot be routed or closed', async () => {
    const router = new StructuredAgentSessionAdapterRouter(
      { codex: adapter(), claude: adapter() },
      async () => undefined
    )

    await expect(router.closeSession('missing-session')).resolves.toBe(false)
    await router.acquire({ identity: identity('codex'), fence: 1, spawnToken: 'spawn-codex' })
    await expect(router.closeSession('codex-session')).resolves.toBe(false)
  })

  it('refuses an adapter that does not return explicit exit proof', async () => {
    const closeUnknown = vi.fn(async () => undefined) as unknown as NonNullable<
      StructuredAgentSessionAdapter['closeSession']
    >
    const router = new StructuredAgentSessionAdapterRouter(
      { codex: adapter(closeUnknown), claude: adapter() },
      async () => undefined
    )

    await router.acquire({ identity: identity('codex'), fence: 1, spawnToken: 'spawn-codex' })
    await expect(router.closeSession('codex-session')).resolves.toBe(false)
    // The owner remains routed so a later retry can reach the still-live child.
    await expect(router.closeSession('codex-session')).resolves.toBe(false)
    expect(closeUnknown).toHaveBeenCalledTimes(2)
  })
})

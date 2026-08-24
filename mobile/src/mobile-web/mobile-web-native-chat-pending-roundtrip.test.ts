import { describe, expect, it, vi } from 'vitest'
import {
  parseMobileWebBridgePageMessage,
  parseMobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}

describe('mobile web native chat pending delivery round trip', () => {
  it('resolves page handles before shell persistence and returns only bounded records', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({ worktrees: [{ worktreeId: 'host-workspace', repoId: 'host-repo' }] })
      )
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(success(sessionSnapshot()))
    const sessionChatPendingRead = vi
      .fn()
      .mockResolvedValue([{ text: 'restored pending', expectedOccurrence: 1 }])
    const sessionChatPendingWrite = vi.fn().mockResolvedValue(undefined)
    const rpcClient = { sendRequest } as unknown as RpcClient
    let broker: MobileWebCapabilityBroker
    let requestIndex = 0
    const client = new MobileWebBridgeClient({
      context: CONTEXT,
      grants: [...MOBILE_WEB_PRODUCTION_GRANTS],
      createRequestId: () => `${String.fromCharCode(65 + requestIndex++)}`.repeat(22),
      postMessage(message) {
        const parsed = parseMobileWebBridgePageMessage(JSON.stringify(message), CONTEXT)
        if (!parsed.ok) {
          return false
        }
        void broker.handle(parsed.value)
        return true
      }
    })
    broker = new MobileWebCapabilityBroker({
      context: CONTEXT,
      getClient: () => rpcClient,
      isConnected: () => true,
      isActive: () => true,
      postMessage(message) {
        const parsed = parseMobileWebBridgeShellMessage(JSON.stringify(message), CONTEXT)
        if (!parsed.ok) {
          throw new Error(parsed.error)
        }
        client.receive(parsed.value)
      },
      nativeAuthority: {
        hapticFeedback: vi.fn(),
        clipboardWrite: vi.fn(),
        openExternal: vi.fn(),
        terminalPreferences: vi.fn(),
        terminalTextScaleUpdate: vi.fn(),
        sessionChatPendingRead,
        sessionChatPendingWrite
      },
      terminalClientId: 'device',
      randomBytes: (length) => new Uint8Array(length).fill(1)
    })

    const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
    const session = await client.sessionSnapshot({ workspaceId: workspace.id })
    const tab = session.tabs[0]!
    expect(tab.type).toBe('terminal')
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Expected native chat authority')
    }

    await expect(
      client.nativeChat.pendingRead({
        workspaceId: workspace.id,
        sessionId: tab.nativeChatSessionId
      })
    ).resolves.toEqual({
      deliveries: [{ text: 'restored pending', expectedOccurrence: 1 }]
    })
    await client.nativeChat.pendingWrite({
      workspaceId: workspace.id,
      sessionId: tab.nativeChatSessionId,
      deliveries: [{ text: 'next pending', expectedOccurrence: 2 }]
    })

    expect(sessionChatPendingRead).toHaveBeenCalledWith(
      'host-workspace',
      'host-tab',
      'provider-session'
    )
    expect(sessionChatPendingWrite).toHaveBeenCalledWith(
      'host-workspace',
      'host-tab',
      'provider-session',
      [{ text: 'next pending', expectedOccurrence: 2 }]
    )
    expect(
      JSON.stringify([...sessionChatPendingRead.mock.calls, ...sessionChatPendingWrite.mock.calls])
    ).not.toContain(tab.nativeChatSessionId)
  })
})

function sessionSnapshot() {
  return {
    worktree: 'host-workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeTabId: 'host-tab',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-tab',
        title: 'Codex',
        status: 'ready',
        terminal: 'host-terminal',
        launchAgent: 'codex',
        isActive: true,
        agentStatus: {
          state: 'waiting',
          agentType: 'codex',
          providerSession: { id: 'provider-session' }
        }
      }
    ]
  }
}

function success(result: unknown) {
  return {
    id: 'response',
    ok: true as const,
    result,
    _meta: { runtimeId: 'runtime' }
  }
}

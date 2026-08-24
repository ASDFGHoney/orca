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

describe('mobile web native chat subscription round trip', () => {
  it('tails a restored session through opaque page authority', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({ worktrees: [{ worktreeId: 'host-workspace', repoId: 'host-repo' }] })
      )
      .mockResolvedValueOnce(success(restoredSessionSnapshot()))
      .mockResolvedValueOnce(success(restoredSessionSnapshot()))
    let emitHostEvent: (event: unknown) => void = () => {}
    const unsubscribeHost = vi.fn()
    const subscribe = vi
      .fn<RpcClient['subscribe']>()
      .mockImplementation((_method, _params, onEvent) => {
        emitHostEvent = onEvent
        return unsubscribeHost
      })
    const rpcClient = { sendRequest, subscribe } as unknown as RpcClient
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
        terminalTextScaleUpdate: vi.fn()
      },
      terminalClientId: 'device',
      randomBytes: (length) => new Uint8Array(length).fill(1)
    })

    const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
    const session = await client.sessionSnapshot({ workspaceId: workspace.id })
    const tab = session.tabs[0]!
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Expected native chat authority')
    }
    const events: unknown[] = []
    const errors: unknown[] = []
    const subscription = client.nativeChatSubscribe(
      {
        workspaceId: workspace.id,
        sessionId: tab.nativeChatSessionId,
        limit: 40
      },
      (event) => events.push(event),
      (error) => errors.push(error)
    )

    await expect(subscription.ready).resolves.toBeUndefined()
    expect(subscribe).toHaveBeenCalledWith(
      'nativeChat.subscribe',
      {
        agent: 'codex',
        sessionId: 'provider-session',
        limit: 40,
        subscriptionId: subscription.subscriptionId,
        transcriptPath: '/private/restored-session.jsonl',
        worktreeId: 'host-workspace',
        terminal: 'current-host-terminal'
      },
      expect.any(Function)
    )

    emitHostEvent({
      type: 'snapshot',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Restored' }],
          timestamp: 1,
          source: 'transcript'
        }
      ],
      hasMore: false
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(errors).toEqual([])
    expect(JSON.stringify(events)).not.toContain('provider-session')
    expect(JSON.stringify(events)).not.toContain('/private/restored-session')

    subscription.unsubscribe()
    expect(unsubscribeHost).toHaveBeenCalledOnce()
    client.dispose()
    broker.dispose()
  })
})

function restoredSessionSnapshot() {
  return {
    worktree: 'host-workspace',
    publicationEpoch: 'restored-epoch',
    snapshotVersion: 1,
    activeTabId: 'host-tab',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-tab',
        title: 'Codex',
        status: 'ready',
        terminal: 'current-host-terminal',
        launchAgent: 'codex',
        isActive: true,
        agentStatus: {
          state: 'done',
          agentType: 'codex',
          terminalHandle: 'pre-restart-terminal',
          providerSession: {
            id: 'provider-session',
            transcriptPath: '/private/restored-session.jsonl'
          }
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

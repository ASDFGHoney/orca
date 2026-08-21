import { describe, expect, it, vi } from 'vitest'
import {
  parseMobileWebBridgePageMessage,
  parseMobileWebBridgeShellMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY } from '../tasks/worktree-create-capability'
import { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import { MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS } from './mobile-web-production-workspace-creation-grants'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}

describe('mobile web workspace creation round trip', () => {
  it('carries page requests through schemas and resolves host authority only in native', async () => {
    const shellMessages: MobileWebBridgeShellMessage[] = []
    const consumeRecentUserGesture = vi.fn(() => true)
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [
              {
                id: '/host/repo-secret',
                displayName: 'Orca',
                path: '/Users/private/orca',
                connectionId: 'ssh-private-id'
              }
            ]
          }
        }
      }
      if (method === 'status.get') {
        return {
          ok: true,
          result: { capabilities: [MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY] }
        }
      }
      if (method === 'worktree.create') {
        return { ok: true, result: { worktree: { id: '/host/worktree-secret' } } }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const hostClient = { sendRequest } as unknown as RpcClient
    let broker: MobileWebCapabilityBroker
    let requestIndex = 0
    const pageClient = new MobileWebBridgeClient({
      context: CONTEXT,
      grants: [...MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS],
      createRequestId: () => String.fromCharCode(65 + requestIndex++).repeat(22),
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
      getClient: () => hostClient,
      isConnected: () => true,
      isActive: () => true,
      nativeAuthority: {
        hapticFeedback: vi.fn(),
        clipboardWrite: vi.fn(),
        openExternal: vi.fn(),
        terminalPreferences: vi.fn(),
        terminalTextScaleUpdate: vi.fn()
      },
      terminalClientId: 'native-device-secret',
      randomBytes: (length) => new Uint8Array(length).fill(5),
      navigationAuthority: {
        route: vi.fn(),
        reconnect: vi.fn(),
        removeHost: vi.fn(),
        consumeRecentUserGesture
      },
      postMessage(message) {
        shellMessages.push(message)
        const parsed = parseMobileWebBridgeShellMessage(JSON.stringify(message), CONTEXT)
        if (!parsed.ok) {
          throw new Error(parsed.error)
        }
        pageClient.receive(parsed.value)
      }
    })

    const repositories = await pageClient.workspaceCreation.repositories()
    const result = await pageClient.workspaceCreationCreate.createBlank({
      repoId: repositories.repositories[0]!.id,
      baseName: 'mobile-workspace',
      nameWasGenerated: false,
      agentChoice: 'codex',
      setupDecision: 'skip'
    })

    expect(repositories.repositories).toEqual([
      {
        id: expect.stringMatching(/^repo_/),
        displayName: 'Orca',
        path: '/Users/private/orca',
        connectionId: expect.stringMatching(/^repo_/),
        executionHostId: expect.stringMatching(/^ssh:executionHost_/),
        executionHostLabel: 'Host',
        projectId: expect.stringMatching(/^project_/)
      }
    ])
    expect(result).toEqual({
      workspaceId: expect.stringMatching(/^workspace_/),
      name: 'mobile-workspace'
    })
    expect(consumeRecentUserGesture).toHaveBeenCalledOnce()
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        repo: 'id:/host/repo-secret',
        createdWithAgent: 'codex',
        startupAgent: 'codex'
      }),
      { timeoutMs: 600_000 }
    )
    const createParams = sendRequest.mock.calls.find(
      ([method]) => method === 'worktree.create'
    )?.[1]
    expect(createParams).not.toHaveProperty('startupCommand')
    expect(sendRequest).not.toHaveBeenCalledWith('settings.get')
    expect(JSON.stringify(shellMessages)).not.toMatch(/repo-secret|worktree-secret|ssh-private-id/)

    pageClient.dispose()
    broker.dispose()
  })
})

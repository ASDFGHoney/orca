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

describe('mobile web markdown round trip', () => {
  it('resolves page workspace authority before host reads and shell draft persistence', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({ worktrees: [{ worktreeId: 'host-workspace', repoId: 'host-repo' }] })
      )
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(
        success({
          tabId: 'host-tab',
          filePath: '/secret/worktree/notes.md',
          relativePath: 'notes.md',
          content: 'host content',
          isDirty: false,
          version: 'v1',
          source: 'file',
          editable: true
        })
      )
      .mockResolvedValueOnce(success(sessionSnapshot()))
      .mockResolvedValueOnce(success(sessionSnapshot()))
    const sessionMarkdownDraftRead = vi
      .fn()
      .mockResolvedValue({ content: 'phone draft', baseVersion: 'v1' })
    const sessionMarkdownDraftWrite = vi.fn().mockResolvedValue(undefined)
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
        sessionMarkdownDraftRead,
        sessionMarkdownDraftWrite
      },
      terminalClientId: 'device',
      randomBytes: (length) => new Uint8Array(length).fill(1)
    })

    const workspace = (await client.workspaceSnapshot({ limit: 1 })).workspaces[0]!
    const session = await client.sessionSnapshot({ workspaceId: workspace.id })
    const tab = session.tabs[0]!
    expect(tab).toMatchObject({ type: 'markdown', relativePath: 'notes.md' })

    const readResult = await client.markdown.read({
      workspaceId: workspace.id,
      tabId: tab.id,
      relativePath: 'notes.md',
      tabIsDirty: false
    })
    expect(readResult).toMatchObject({
      content: 'host content',
      baseVersion: 'v1',
      editable: true
    })
    const draftResult = await client.markdown.loadDraft({
      workspaceId: workspace.id,
      tabId: tab.id,
      relativePath: 'notes.md'
    })
    expect(draftResult).toEqual({ content: 'phone draft', baseVersion: 'v1' })
    await client.markdown.saveDraft({
      workspaceId: workspace.id,
      tabId: tab.id,
      relativePath: 'notes.md',
      draft: { content: 'next draft', baseVersion: 'v1' }
    })

    expect(sessionMarkdownDraftRead).toHaveBeenCalledWith('host-workspace', 'host-tab', 'notes.md')
    expect(sessionMarkdownDraftWrite).toHaveBeenCalledWith(
      'host-workspace',
      'host-tab',
      'notes.md',
      { content: 'next draft', baseVersion: 'v1' }
    )
    expect(workspace.id).not.toBe('host-workspace')
    expect(JSON.stringify({ readResult, draftResult })).not.toContain('/secret/worktree')
  })
})

function sessionSnapshot() {
  return {
    worktree: 'host-workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeTabId: 'host-tab',
    activeTabType: 'markdown',
    tabs: [
      {
        type: 'markdown',
        id: 'host-tab',
        title: 'notes.md',
        filePath: '/secret/worktree/notes.md',
        relativePath: 'notes.md',
        isDirty: false,
        isActive: true,
        documentVersion: 'v1'
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

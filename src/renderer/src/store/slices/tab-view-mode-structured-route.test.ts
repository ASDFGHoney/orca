/**
 * Both ways into structured chat go through one door.
 *
 * Right-click → "Switch to chat" and launching a Codex tab with open-in-chat both end at
 * `setTabViewMode(tabId, 'chat')`, which hands a terminal tab to `setTerminalNativeChatMode` and
 * from there to `agentSession.adoptTerminal`. Pinning that here is what makes "launch-at-chat
 * shares the adoption defect" a checked claim rather than an inspection of the call graph.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeUnifiedTab, makeTabGroup } from './store-test-helpers'
import type * as StructuredNativeChatToggle from './structured-native-chat-toggle'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const { mockSetTerminalNativeChatMode } = vi.hoisted(() => ({
  mockSetTerminalNativeChatMode: vi.fn()
}))

vi.mock('./structured-native-chat-toggle', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredNativeChatToggle>()),
  setTerminalNativeChatMode: mockSetTerminalNativeChatMode
}))

const mockApi = {
  ui: { set: vi.fn().mockResolvedValue(undefined) },
  settings: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) }
}

// @ts-expect-error -- partial window stub is sufficient for these store-only tests
globalThis.window = { api: mockApi }

const WT = 'repo1::/tmp/feature'

describe('structured chat route out of setTabViewMode', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    mockSetTerminalNativeChatMode.mockReset()
    mockSetTerminalNativeChatMode.mockResolvedValue('structured')
    store = createTestStore()
    store.setState({
      unifiedTabsByWorktree: {
        [WT]: [makeUnifiedTab({ id: 'codex-tab', worktreeId: WT, groupId: 'g-1' })]
      },
      groupsByWorktree: {
        [WT]: [
          makeTabGroup({
            id: 'g-1',
            worktreeId: WT,
            activeTabId: 'codex-tab',
            tabOrder: ['codex-tab']
          })
        ]
      }
    } as Partial<AppState>)
  })

  it('hands an explicit chat mode to the structured adoption path', () => {
    store.getState().setTabViewMode('codex-tab', 'chat')

    expect(mockSetTerminalNativeChatMode).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'codex-tab', mode: 'chat' })
    )
  })

  it('hands a toggled chat mode to the same path', () => {
    store.getState().toggleTabViewMode('codex-tab')

    expect(mockSetTerminalNativeChatMode).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'codex-tab', mode: 'chat' })
    )
  })
})

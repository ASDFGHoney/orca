// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoAckViewedAgent } from './useAutoAckViewedAgent'
import { useAppStore } from '../store'
import { selectFloatingWorkspaceHasUnread } from '../store/selectors'
import { makeTab } from '../store/slices/store-test-helpers'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'

const FLOATING_TAB_ID = 'tab-floating'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const FLOATING_PANE_KEY = makePaneKey(FLOATING_TAB_ID, LEAF_ID)

function seedFloatingCompletion(): void {
  useAppStore.setState({
    activeView: 'activity',
    activeTabId: null,
    activeWorktreeId: 'wt-1',
    activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TAB_ID },
    tabsByWorktree: {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        makeTab({ id: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
      ]
    },
    terminalLayoutsByTabId: {
      [FLOATING_TAB_ID]: { root: null, activeLeafId: LEAF_ID, expandedLeafId: null }
    },
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: {},
    acknowledgedAgentsByPaneKey: {}
  })
}

describe('useAutoAckViewedAgent — floating workspace panel visibility', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    seedFloatingCompletion()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps the attention dot lit while the panel is closed and clears it once it opens', () => {
    const hook = renderHook(
      ({ floatingPanelVisible }: { floatingPanelVisible: boolean }) =>
        useAutoAckViewedAgent(floatingPanelVisible),
      { initialProps: { floatingPanelVisible: false } }
    )

    // The dot is the only signal a closed panel has, so a store write while hidden must not ack it.
    useAppStore.getState().markAgentCompletionPaneUnread(FLOATING_PANE_KEY)
    expect(selectFloatingWorkspaceHasUnread(useAppStore.getState())).toBe(true)

    hook.rerender({ floatingPanelVisible: true })

    expect(selectFloatingWorkspaceHasUnread(useAppStore.getState())).toBe(false)
  })
})

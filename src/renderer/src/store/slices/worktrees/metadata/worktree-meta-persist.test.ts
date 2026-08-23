import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  capturePassiveWorktreeMetaRequestFences,
  resetPassiveWorktreeMetaMutationsForTests,
  shouldPreservePassiveWorktreeMetaField
} from './passive-worktree-meta-mutation'
import { persistWorktreeMeta } from './worktree-meta-persist'

const WORKTREE_ID = 'repo::/worktree'
const HOST_ID = 'local'

beforeEach(() => {
  resetPassiveWorktreeMetaMutationsForTests()
  vi.unstubAllGlobals()
})

describe('worktree metadata persistence fencing', () => {
  it('tracks passive fields for every caller of the common persistence boundary', async () => {
    let settle!: () => void
    const updateMeta = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    vi.stubGlobal('window', { api: { worktrees: { updateMeta } } })

    const persistence = persistWorktreeMeta(
      { settings: null, executionHostId: HOST_ID },
      WORKTREE_ID,
      { isUnread: true, lastActivityAt: 10 }
    )
    const requestFence = capturePassiveWorktreeMetaRequestFences(HOST_ID, [WORKTREE_ID]).get(
      WORKTREE_ID
    )

    expect(
      shouldPreservePassiveWorktreeMetaField(HOST_ID, WORKTREE_ID, 'isUnread', requestFence)
    ).toBe(true)
    expect(
      shouldPreservePassiveWorktreeMetaField(HOST_ID, WORKTREE_ID, 'lastActivityAt', requestFence)
    ).toBe(true)

    settle()
    await persistence
    const laterRequestFence = capturePassiveWorktreeMetaRequestFences(HOST_ID, [WORKTREE_ID]).get(
      WORKTREE_ID
    )
    expect(
      shouldPreservePassiveWorktreeMetaField(HOST_ID, WORKTREE_ID, 'isUnread', laterRequestFence)
    ).toBe(false)
  })
})

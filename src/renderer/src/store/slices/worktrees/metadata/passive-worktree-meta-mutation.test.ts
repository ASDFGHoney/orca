import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginPassiveWorktreeMetaMutation,
  capturePassiveWorktreeMetaRequestFences,
  forgetPassiveWorktreeMetaMutations,
  resetPassiveWorktreeMetaMutationsForTests,
  settlePassiveWorktreeMetaMutation,
  shouldPreservePassiveWorktreeMetaField
} from './passive-worktree-meta-mutation'

const WORKTREE_ID = 'repo::/worktree'
const HOST_ID = 'local'

beforeEach(resetPassiveWorktreeMetaMutationsForTests)

describe('passive worktree meta mutation', () => {
  it('fences a request that starts while persistence is pending', () => {
    const mutation = beginPassiveWorktreeMetaMutation(HOST_ID, WORKTREE_ID, { isUnread: true })
    const fence = capturePassiveWorktreeMetaRequestFences(HOST_ID, [WORKTREE_ID]).get(WORKTREE_ID)

    expect(shouldPreservePassiveWorktreeMetaField(HOST_ID, WORKTREE_ID, 'isUnread', fence)).toBe(
      true
    )
    settlePassiveWorktreeMetaMutation(mutation)
    expect(shouldPreservePassiveWorktreeMetaField(HOST_ID, WORKTREE_ID, 'isUnread', fence)).toBe(
      true
    )
    const settledFence = capturePassiveWorktreeMetaRequestFences(HOST_ID, [WORKTREE_ID]).get(
      WORKTREE_ID
    )
    expect(
      shouldPreservePassiveWorktreeMetaField(HOST_ID, WORKTREE_ID, 'isUnread', settledFence)
    ).toBe(false)
  })

  it('fences a mutation that settles after a request starts', () => {
    const fence = capturePassiveWorktreeMetaRequestFences(HOST_ID, [WORKTREE_ID]).get(WORKTREE_ID)
    const mutation = beginPassiveWorktreeMetaMutation(HOST_ID, WORKTREE_ID, {
      lastActivityAt: 10
    })
    settlePassiveWorktreeMetaMutation(mutation)

    expect(
      shouldPreservePassiveWorktreeMetaField(HOST_ID, WORKTREE_ID, 'lastActivityAt', fence)
    ).toBe(true)
  })

  it('cannot let an old settlement clear a recreated worktree mutation', () => {
    const oldMutation = beginPassiveWorktreeMetaMutation(HOST_ID, WORKTREE_ID, { isUnread: true })
    forgetPassiveWorktreeMetaMutations(HOST_ID, [WORKTREE_ID])
    const recreatedMutation = beginPassiveWorktreeMetaMutation(HOST_ID, WORKTREE_ID, {
      isUnread: false
    })
    const fence = capturePassiveWorktreeMetaRequestFences(HOST_ID, [WORKTREE_ID]).get(WORKTREE_ID)

    settlePassiveWorktreeMetaMutation(oldMutation)
    expect(shouldPreservePassiveWorktreeMetaField(HOST_ID, WORKTREE_ID, 'isUnread', fence)).toBe(
      true
    )
    settlePassiveWorktreeMetaMutation(recreatedMutation)
    const settledFence = capturePassiveWorktreeMetaRequestFences(HOST_ID, [WORKTREE_ID]).get(
      WORKTREE_ID
    )
    expect(
      shouldPreservePassiveWorktreeMetaField(HOST_ID, WORKTREE_ID, 'isUnread', settledFence)
    ).toBe(false)
  })

  it('isolates the same worktree id across execution hosts', () => {
    const runtimeHost = 'runtime:paired'
    beginPassiveWorktreeMetaMutation(HOST_ID, WORKTREE_ID, { isUnread: true })
    const runtimeFence = capturePassiveWorktreeMetaRequestFences(runtimeHost, [WORKTREE_ID]).get(
      WORKTREE_ID
    )

    expect(
      shouldPreservePassiveWorktreeMetaField(runtimeHost, WORKTREE_ID, 'isUnread', runtimeFence)
    ).toBe(false)
  })
})

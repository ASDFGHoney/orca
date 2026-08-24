import { describe, expect, it } from 'vitest'
import { resolveWorktreeStatus } from './worktree-status'

// Why these live apart from the main suite: they pin the ONE rule STA-5357 adds —
// an interrupted agent is not a completed one, and it must not be masked by a
// sibling that merely finished.
const base = {
  tabs: [] as never[],
  browserTabs: [] as never[],
  ptyIdsByTabId: {},
  hasPermission: false,
  hasLiveWorking: false,
  hasLiveDone: false,
  hasRetainedDone: false
}

describe('resolveWorktreeStatus — interrupted (STA-5357)', () => {
  it('reports interrupted rather than done for an interrupted agent', () => {
    // Why `hasLiveDone` is also set: `interrupted` only ever coexists with `done`
    // (agent-status-types.ts clamps it), so the done flag is always present too.
    // Before the fix that made the card indistinguishable from a clean finish.
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveDone: true })).toBe(
      'interrupted'
    )
  })

  it('keeps interrupted visible when a sibling agent merely finished', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveDone: true })).not.toBe(
      'done'
    )
  })

  it('outranks working, so a cancelled turn is not hidden by a busy sibling', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveWorking: true })).toBe(
      'interrupted'
    )
  })

  it('yields to permission — a prompt waiting on the user is more urgent', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasPermission: true })).toBe(
      'permission'
    )
  })

  it('outranks monitoring', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveMonitoring: true })).toBe(
      'interrupted'
    )
  })

  it('leaves every other combination alone', () => {
    expect(resolveWorktreeStatus({ ...base, hasLiveDone: true })).toBe('done')
    expect(resolveWorktreeStatus({ ...base, hasLiveWorking: true })).toBe('working')
    expect(resolveWorktreeStatus({ ...base, hasLiveMonitoring: true })).toBe('monitoring')
    expect(resolveWorktreeStatus({ ...base, hasPermission: true })).toBe('permission')
  })
})

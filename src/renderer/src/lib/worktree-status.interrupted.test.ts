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
    // The bug: `interrupted` is clamped onto `done` at parse time, so the summary swallowed it into
    // hasLiveDone and the card rendered a cancelled turn as a clean finish.
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true })).toBe('interrupted')
  })

  it('is never the emerald done state on its own', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true })).not.toBe('done')
  })

  // Why interrupted YIELDS to everything else: Esc / Ctrl+C is a deliberate act, so the user already
  // knows. It is the least attention-demanding state — smart-attention already classes it 4 (idle),
  // below both done and working. Distinguishable from done, never louder than a live agent.
  it('yields to a working sibling — the live agent is the louder signal', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveWorking: true })).toBe(
      'working'
    )
  })

  it('yields to permission — a prompt waiting on the user is more urgent', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasPermission: true })).toBe(
      'permission'
    )
  })

  it('yields to monitoring — background work is still live', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveMonitoring: true })).toBe(
      'monitoring'
    )
  })

  it('yields to a sibling that genuinely finished', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveDone: true })).toBe('done')
  })

  it('leaves every other combination alone', () => {
    expect(resolveWorktreeStatus({ ...base, hasLiveDone: true })).toBe('done')
    expect(resolveWorktreeStatus({ ...base, hasLiveWorking: true })).toBe('working')
    expect(resolveWorktreeStatus({ ...base, hasLiveMonitoring: true })).toBe('monitoring')
    expect(resolveWorktreeStatus({ ...base, hasPermission: true })).toBe('permission')
  })
})

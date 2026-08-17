import { describe, expect, it, vi } from 'vitest'
import { beginHostQualifiedRemoval } from './host-qualified-worktree-removal'

const WORKTREE_ID = 'repo1::/shared/workspace/path'

/**
 * Callers mark rows deleting up front for immediate sidebar feedback
 * (worktree-delete-execution.ts). These refusals return BEFORE removeWorktree's
 * try/catch, which is the only other place that clears the flag — so without an
 * explicit clear the workspace keeps its "Deleting…" spinner indefinitely, long
 * after the 10s failure toast has gone.
 */
// Note: with a confirmed host the route resolves from the host id alone, so this refusal is
// reached on the UNQUALIFIED path — a caller that names no host and has no resolvable owner.
describe('beginHostQualifiedRemoval refusals clear the delete state', () => {
  function makeGet(clearWorktreeDeleteState: ReturnType<typeof vi.fn>) {
    // Minimal store surface: no worktrees, so no route can resolve for MISSING_HOST.
    return () =>
      ({
        clearWorktreeDeleteState,
        allWorktrees: () => [],
        worktreesByRepo: {},
        repos: [],
        detectedWorktreesByRepo: {},
        settings: {},
        sshConnectionStates: new Map(),
        sshTargetLabels: new Map(),
        workspaceCleanupScan: null
      }) as never
  }

  it('clears when no route resolves and no host was confirmed', () => {
    const clearWorktreeDeleteState = vi.fn()
    const start = beginHostQualifiedRemoval(
      makeGet(clearWorktreeDeleteState),
      WORKTREE_ID,
      null,
      false
    )

    expect(start.ok).toBe(false)
    expect(clearWorktreeDeleteState).toHaveBeenCalledWith(WORKTREE_ID)
  })
})

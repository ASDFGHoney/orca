/**
 * Runtime `automation.create` / `update` resolve `workspace` through
 * `showManagedWorktree`. The CLI always sends `id:<worktreeId>`; a bare stored
 * id is a remote-only miss (`selector_not_found`) because local IPC never
 * parses a selector.
 */
const WORKTREE_SELECTOR_PREFIX = /^(id|path|name|branch|issue):/

export function runtimeAutomationWorkspaceSelector(
  workspaceId: string | null | undefined
): string | undefined {
  if (!workspaceId) {
    return undefined
  }
  return WORKTREE_SELECTOR_PREFIX.test(workspaceId) ? workspaceId : `id:${workspaceId}`
}

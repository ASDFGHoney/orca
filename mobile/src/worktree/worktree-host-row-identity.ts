import type { Worktree } from './workspace-list-types'

/** A worktreeId repeats across hosts, so a row is only the same row on the same host. */
export function isSameWorktreeRow(
  a: Pick<Worktree, 'worktreeId' | 'hostId'>,
  b: Pick<Worktree, 'worktreeId' | 'hostId'>
): boolean {
  return a.worktreeId === b.worktreeId && a.hostId === b.hostId
}

/** Drops only the removed row, leaving a same-id workspace on another host visible. */
export function removeWorktreeRow(
  list: readonly Worktree[],
  removed: Pick<Worktree, 'worktreeId' | 'hostId'>
): Worktree[] {
  return list.filter((entry) => !isSameWorktreeRow(entry, removed))
}

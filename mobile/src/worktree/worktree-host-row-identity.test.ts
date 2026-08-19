import { describe, expect, it } from 'vitest'
import { removeWorktreeRow } from './worktree-host-row-identity'
import type { Worktree } from './workspace-list-types'

function row(worktreeId: string, hostId: string): Worktree {
  return { worktreeId, hostId, displayName: worktreeId } as Worktree
}

describe('removeWorktreeRow', () => {
  // Deleting on one host used to clear the other host's identically-named row from the list.
  it('keeps a same-id workspace that lives on another host', () => {
    const local = row('shared', 'host-a')
    const remote = row('shared', 'host-b')

    expect(removeWorktreeRow([local, remote], local)).toEqual([remote])
  })

  it('removes the matching row', () => {
    const only = row('shared', 'host-a')

    expect(removeWorktreeRow([only], only)).toEqual([])
  })
})

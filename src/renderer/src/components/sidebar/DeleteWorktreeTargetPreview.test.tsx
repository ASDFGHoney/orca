import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'

function makeWorktree(id: string, displayName: string, hostId?: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'repo1',
    path: `/work/${displayName}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName,
    ...(hostId ? { hostId } : {})
  } as Worktree
}

function render(worktrees: readonly Worktree[]): string {
  return renderToStaticMarkup(
    <DeleteWorktreeTargetPreview
      isBatchDelete={true}
      worktree={null}
      worktrees={worktrees}
      deleteStateByWorktreeId={{}}
      dirtyChangeCountsByWorktreeId={new Map()}
    />
  )
}

describe('DeleteWorktreeTargetPreview host labels', () => {
  // Two hosts publish the same worktreeId, so name and path are identical in the batch —
  // without the host there is nothing on screen distinguishing what is about to be destroyed.
  it('names each host when the batch contains a same-id collision', () => {
    const markup = render([
      makeWorktree('shared', 'collide', 'local'),
      makeWorktree('shared', 'collide', 'ssh:qa-linux-42')
    ])

    expect(markup).toContain(getExecutionHostLabel('local'))
    expect(markup).toContain(getExecutionHostLabel('ssh:qa-linux-42'))
  })

  // Ordinary batches stay quiet: a host label on every row is noise, not information.
  it('omits host labels when every row has a distinct id', () => {
    const markup = render([
      makeWorktree('one', 'alpha', 'local'),
      makeWorktree('two', 'beta', 'ssh:qa-linux-42')
    ])

    expect(markup).not.toContain(getExecutionHostLabel('ssh:qa-linux-42'))
  })
})

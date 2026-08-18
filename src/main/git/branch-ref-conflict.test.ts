import { describe, expect, it } from 'vitest'

import {
  buildBranchRefConflictArgv,
  classifyBranchRefDirectoryConflict,
  formatBranchConflictMessage
} from './branch-ref-conflict'

function refs(...shortNames: string[]): string {
  return shortNames.map((name) => `refs/heads/${name}`).join('\n')
}

describe('buildBranchRefConflictArgv', () => {
  it('probes the name itself plus every proper prefix, longest first', () => {
    expect(buildBranchRefConflictArgv('team/a/b/c')).toEqual([
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/team/a/b/c',
      'refs/heads/team/a/b',
      'refs/heads/team/a',
      'refs/heads/team'
    ])
  })

  it('probes only the name itself for a flat branch', () => {
    expect(buildBranchRefConflictArgv('feature')).toEqual([
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/feature'
    ])
  })

  it('never emits an argument git could read as an option', () => {
    for (const arg of buildBranchRefConflictArgv('release/1.0').slice(2)) {
      expect(arg.startsWith('refs/heads/')).toBe(true)
    }
  })
})

describe('classifyBranchRefDirectoryConflict', () => {
  it('reports a directory conflict when refs nest under the requested name', () => {
    expect(classifyBranchRefDirectoryConflict('feature', refs('feature/tti_fix_1440'))).toEqual({
      direction: 'directory',
      existingBranch: 'feature/tti_fix_1440'
    })
  })

  it('reports a file conflict when a shorter ref blocks the requested name', () => {
    expect(classifyBranchRefDirectoryConflict('release/1.0', refs('release'))).toEqual({
      direction: 'file',
      existingBranch: 'release'
    })
  })

  it('matches a blocking prefix at any depth', () => {
    expect(classifyBranchRefDirectoryConflict('team/a/b/c', refs('team/a'))).toEqual({
      direction: 'file',
      existingBranch: 'team/a'
    })
  })

  it('ignores siblings the over-matching prefix patterns drag in', () => {
    // Probing `release/1.0` also returns `release/2.0` via the `refs/heads/release` pattern.
    expect(classifyBranchRefDirectoryConflict('release/1.0', refs('release/2.0'))).toBeNull()
  })

  it('does not treat a name-sharing sibling as a conflict', () => {
    expect(classifyBranchRefDirectoryConflict('feature', refs('featurex', 'feature2/z'))).toBeNull()
  })

  it('returns null for empty output', () => {
    expect(classifyBranchRefDirectoryConflict('feature', '')).toBeNull()
  })

  it('does not classify the exact ref as a directory conflict', () => {
    // The exact case is a plain `local` conflict the caller detects first.
    expect(classifyBranchRefDirectoryConflict('feature/x', refs('feature/x'))).toBeNull()
  })

  it('prefers the blocking shorter ref over a nested one', () => {
    expect(
      classifyBranchRefDirectoryConflict('release/1.0', refs('release/1.0/hotfix', 'release'))
    ).toEqual({ direction: 'file', existingBranch: 'release' })
  })

  it('tolerates CRLF output and ignores non-branch lines', () => {
    expect(
      classifyBranchRefDirectoryConflict(
        'feature',
        'refs/tags/feature/x\r\nrefs/heads/feature/x\r\n'
      )
    ).toEqual({ direction: 'directory', existingBranch: 'feature/x' })
  })
})

describe('formatBranchConflictMessage', () => {
  it('keeps the existing wording for exact local and remote conflicts', () => {
    expect(formatBranchConflictMessage('feature/foo', 'local', 'branch name')).toBe(
      'Branch "feature/foo" already exists locally. Pick a different branch name.'
    )
    expect(formatBranchConflictMessage('feature/foo', 'remote', 'worktree name')).toBe(
      'Branch "feature/foo" already exists on a remote. Pick a different worktree name.'
    )
  })

  it('omits the advice clause when no subject is given', () => {
    expect(formatBranchConflictMessage('feature/foo', 'local')).toBe(
      'Branch "feature/foo" already exists locally.'
    )
  })

  it('does not claim a directory conflict already exists', () => {
    const message = formatBranchConflictMessage('feature', 'local-directory', 'worktree name')

    expect(message).toBe(
      'Branch "feature" conflicts with an existing branch name in this repo. Git cannot store both. Pick a different worktree name.'
    )
    expect(message).not.toContain('already exists')
  })
})

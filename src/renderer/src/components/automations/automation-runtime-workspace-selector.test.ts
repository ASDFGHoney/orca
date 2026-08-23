import { describe, expect, it } from 'vitest'
import { runtimeAutomationWorkspaceSelector } from './automation-runtime-workspace-selector'

describe('runtimeAutomationWorkspaceSelector', () => {
  it('prefixes a stored worktree id the way the CLI does', () => {
    expect(runtimeAutomationWorkspaceSelector('repo-1::/tmp/orca/feature')).toBe(
      'id:repo-1::/tmp/orca/feature'
    )
  })

  it('leaves an already-qualified selector alone', () => {
    expect(runtimeAutomationWorkspaceSelector('id:repo-1::/tmp/orca/feature')).toBe(
      'id:repo-1::/tmp/orca/feature'
    )
    expect(runtimeAutomationWorkspaceSelector('path:/tmp/orca/feature')).toBe(
      'path:/tmp/orca/feature'
    )
  })

  it('omits an empty workspace', () => {
    expect(runtimeAutomationWorkspaceSelector(undefined)).toBeUndefined()
    expect(runtimeAutomationWorkspaceSelector(null)).toBeUndefined()
    expect(runtimeAutomationWorkspaceSelector('')).toBeUndefined()
  })
})

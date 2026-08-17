import { describe, expect, it } from 'vitest'
import { buildWorktreePaletteItemIds } from './worktree-palette-item-id'

describe('buildWorktreePaletteItemIds', () => {
  it('keeps a single host-qualified row on the clean searchable id', () => {
    const ids = buildWorktreePaletteItemIds([
      { worktreeId: 'repo::path', worktreeHostId: 'ssh:box' }
    ])

    expect(ids.get('ssh:box|repo::path')).toBe('worktree:repo::path')
  })

  it('qualifies only the colliding rows that need distinct cmdk values', () => {
    const ids = buildWorktreePaletteItemIds([
      { worktreeId: 'repo::path', worktreeHostId: 'local' },
      { worktreeId: 'repo::path', worktreeHostId: 'ssh:box' }
    ])

    expect([...ids.values()]).toEqual(['worktree:local|repo::path', 'worktree:ssh:box|repo::path'])
  })
})

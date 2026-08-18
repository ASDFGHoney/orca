import { describe, expect, it } from 'vitest'
import { buildPaletteListEntryRenderKeys } from './palette-list-entry-render-keys'

describe('buildPaletteListEntryRenderKeys', () => {
  it('leaves unique ids untouched', () => {
    const ids = ['__header_open_tabs__', 'workspace-tab:a', 'worktree:b']
    expect(buildPaletteListEntryRenderKeys(ids)).toEqual(ids)
  })

  it('disambiguates a repeated persisted id', () => {
    expect(
      buildPaletteListEntryRenderKeys([
        'workspace-tab:editor:lungfish',
        'workspace-tab:editor:lungfish',
        'workspace-tab:editor:lungfish'
      ])
    ).toEqual([
      'workspace-tab:editor:lungfish',
      'workspace-tab:editor:lungfish#dup1',
      'workspace-tab:editor:lungfish#dup2'
    ])
  })

  it('never emits a key twice', () => {
    const keys = buildPaletteListEntryRenderKeys(['a', 'a', 'b', 'a', 'b', 'a#dup1'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps keys stable as later entries drop away', () => {
    const full = buildPaletteListEntryRenderKeys(['header', 'tab:x', 'tab:x', 'tab:y'])
    const narrowed = buildPaletteListEntryRenderKeys(['header', 'tab:x', 'tab:x'])
    expect(narrowed).toEqual(full.slice(0, 3))
  })
})

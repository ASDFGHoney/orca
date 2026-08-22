import { describe, expect, it } from 'vitest'
import type { PinnedWorktreeDisplayPolicy } from '../../../src/shared/worktree/pinned-display-policy'
import type { MobileGroupMode } from './workspace-view-settings'
import { buildSections, type Section, type Worktree } from './workspace-list-sections'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from './mobile-workspace-statuses'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: 'worktree',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/pinned',
    displayName: 'worktree',
    path: '/tmp/worktree',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

function sectionsFor(
  worktrees: Worktree[],
  groupMode: MobileGroupMode,
  policy?: PinnedWorktreeDisplayPolicy
): Section[] {
  return buildSections(
    worktrees,
    'manual',
    { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
    '',
    groupMode,
    new Set(),
    new Map(),
    DEFAULT_MOBILE_WORKSPACE_STATUSES,
    new Set(),
    policy
  )
}

function sectionKeysContaining(sections: Section[], worktreeId: string): string[] {
  return sections.flatMap((section) =>
    section.data.filter((row) => row.worktreeId === worktreeId).map(() => section.key)
  )
}

const GROUP_MODES: MobileGroupMode[] = ['none', 'repo', 'workspaceStatus', 'prStatus']

describe('buildSections pinned display policy', () => {
  const pinned = worktree({ worktreeId: 'pinned', displayName: 'pinned', isPinned: true })

  it.each(GROUP_MODES)('renders a pinned workspace once by default in %s grouping', (groupMode) => {
    expect(sectionKeysContaining(sectionsFor([pinned], groupMode), 'pinned')).toEqual(['pinned'])
  })

  it.each(GROUP_MODES)('renders a pinned workspace once for single-location in %s', (groupMode) => {
    const sections = sectionsFor([pinned], groupMode, 'single-location')
    expect(sectionKeysContaining(sections, 'pinned')).toEqual(['pinned'])
  })

  it.each(GROUP_MODES)('duplicates into the natural group when opted in for %s', (groupMode) => {
    const keys = sectionKeysContaining(
      sectionsFor([pinned], groupMode, 'duplicate-in-groups'),
      'pinned'
    )
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe('pinned')
    expect(keys[1]).not.toBe('pinned')
  })

  it('keeps a pinned folder workspace out of its repo group', () => {
    const folder = worktree({
      worktreeId: 'folder',
      workspaceKind: 'folder-workspace',
      isPinned: true
    })
    expect(sectionKeysContaining(sectionsFor([folder], 'repo'), 'folder')).toEqual(['pinned'])
  })

  it('leaves a same-id workspace on another host in its natural group', () => {
    const pinnedOnHostA = worktree({ worktreeId: 'shared', hostId: 'host-a', isPinned: true })
    const unpinnedOnHostB = worktree({ worktreeId: 'shared', hostId: 'host-b' })

    const sections = sectionsFor([pinnedOnHostA, unpinnedOnHostB], 'none')

    expect(sections.find((section) => section.key === 'pinned')?.data).toHaveLength(1)
    expect(
      sections.find((section) => section.key === 'all')?.data.map((row) => row.hostId)
    ).toEqual(['host-b'])
  })

  // Desktop pulls the pinned lineage subtree into Pinned via getPinnedSectionWorktrees; mobile's
  // Pinned section is flat, so the child stays in its natural group at depth 0 — visible once.
  it('keeps an unpinned child of a pinned parent visible exactly once', () => {
    const parent = worktree({
      worktreeId: 'parent',
      displayName: 'parent',
      isPinned: true,
      worktreeInstanceId: 'parent-instance'
    })
    const child = worktree({
      worktreeId: 'child',
      displayName: 'child',
      parentWorktreeId: 'parent',
      worktreeInstanceId: 'child-instance',
      lineageWorktreeInstanceId: 'child-instance',
      parentWorktreeInstanceId: 'parent-instance'
    })

    const sections = sectionsFor([parent, child], 'none')

    expect(sectionKeysContaining(sections, 'child')).toEqual(['all'])
    expect(sectionKeysContaining(sections, 'parent')).toEqual(['pinned'])
    const childRow = sections
      .flatMap((section) => section.data)
      .find((row) => row.worktreeId === 'child')
    expect(childRow?.lineageDepth ?? 0).toBe(0)
  })
})

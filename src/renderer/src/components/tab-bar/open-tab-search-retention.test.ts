import { describe, expect, it } from 'vitest'
import type { OpenTabSearchResult } from './open-tab-search'
import { retainOpenTabResultsForQuery } from './open-tab-search-retention'

function tabResult(overrides: Partial<OpenTabSearchResult> = {}): OpenTabSearchResult {
  return {
    executionHostId: 'local',
    source: 'workspace',
    id: 'open-tab:workspace:tab-1',
    title: 'Add tab search and jump in worktree',
    matchedText: null,
    worktreeId: 'wt',
    contentType: 'terminal',
    tabId: 'tab-1',
    entityId: 'term-1',
    groupId: 'g',
    relativePath: null,
    ...overrides
  } as OpenTabSearchResult
}

describe('retainOpenTabResultsForQuery', () => {
  const results = [tabResult()]

  it('returns the same list when the deferred query has caught up', () => {
    expect(
      retainOpenTabResultsForQuery({
        query: 'add tab',
        results,
        resultsQuery: 'add tab'
      })
    ).toBe(results)
  })

  it('treats extra surrounding whitespace as the same query', () => {
    expect(
      retainOpenTabResultsForQuery({
        query: '  add tab ',
        results,
        resultsQuery: 'add tab'
      })
    ).toBe(results)
  })

  it('keeps rows while the user backspaces into a prefix of the deferred query', () => {
    expect(
      retainOpenTabResultsForQuery({
        query: 'add ta',
        results,
        resultsQuery: 'add tab'
      })
    ).toBe(results)
  })

  it('keeps a row whose title still contains the newer query', () => {
    expect(
      retainOpenTabResultsForQuery({
        query: 'jump in',
        results,
        resultsQuery: 'add tab'
      })
    ).toEqual(results)
  })

  it('keeps a row whose matched secondary text still contains the newer query', () => {
    const secondary = [
      tabResult({
        title: 'Claude Code',
        matchedText: 'fix the flaky retry test'
      })
    ]
    expect(
      retainOpenTabResultsForQuery({
        query: 'flaky retry',
        results: secondary,
        resultsQuery: 'fix the'
      })
    ).toEqual(secondary)
  })

  it('keeps an editor row whose relative path still contains the newer query', () => {
    const editor = [
      tabResult({
        title: 'zebra.ts',
        contentType: 'editor',
        relativePath: 'src/zebra.ts'
      })
    ]
    expect(
      retainOpenTabResultsForQuery({
        query: 'zebra.ts',
        results: editor,
        resultsQuery: 'zeb'
      })
    ).toEqual(editor)
  })

  it('drops rows that no longer mention the newer query', () => {
    expect(
      retainOpenTabResultsForQuery({
        query: 'add tabs',
        results,
        resultsQuery: 'add tab'
      })
    ).toEqual([])
  })

  it('drops every row once the live query is cleared', () => {
    expect(
      retainOpenTabResultsForQuery({
        query: '   ',
        results,
        resultsQuery: 'add tab'
      })
    ).toEqual([])
  })
})

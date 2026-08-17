import { retainOpenTabResultsForQuery } from './open-tab-search-retention'
import { EMPTY_TAB_RESULTS } from './tab-create-entry-empty-options'
import { useOpenTabSearch } from './use-open-tab-search'
import type { OpenTabSearchResult } from './open-tab-search'

export function useTabCreateEntrySearchResults({
  enabled,
  query,
  worktreeId
}: {
  enabled: boolean
  query: string
  worktreeId: string
}): readonly OpenTabSearchResult[] {
  const tabSearch = useOpenTabSearch({
    enabled,
    query: enabled ? query : '',
    worktreeId
  })
  // Why retain instead of clearing: emptying deferred rows flashes the list on
  // every keystroke. Kept rows still mention the live query, so Enter cannot
  // submit a tab the current text never matched.
  return enabled
    ? retainOpenTabResultsForQuery({
        query,
        results: tabSearch.results,
        resultsQuery: tabSearch.query
      })
    : EMPTY_TAB_RESULTS
}

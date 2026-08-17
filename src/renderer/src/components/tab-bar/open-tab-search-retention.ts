// Keeps deferred tab rows on screen while typing races ahead of search.

import type { OpenTabSearchResult } from './open-tab-search'

export function retainOpenTabResultsForQuery({
  query,
  results,
  resultsQuery
}: {
  query: string
  results: readonly OpenTabSearchResult[]
  resultsQuery: string
}): readonly OpenTabSearchResult[] {
  const current = query.trim()
  const previous = resultsQuery.trim()
  if (previous === current) {
    return results
  }
  if (!current) {
    return []
  }
  const needle = current.toLowerCase()
  // Why keep the whole list on a shorter prefix: every previous substring match
  // still matches, so dropping rows here would flash the list on backspace.
  if (previous.toLowerCase().startsWith(needle)) {
    return results
  }
  return results.filter((result) => openTabResultStillMatchesQuery(result, needle))
}

function openTabResultStillMatchesQuery(result: OpenTabSearchResult, needle: string): boolean {
  if (result.title.toLowerCase().includes(needle)) {
    return true
  }
  if (result.matchedText?.toLowerCase().includes(needle)) {
    return true
  }
  return Boolean(
    result.source === 'workspace' && result.relativePath?.toLowerCase().includes(needle)
  )
}

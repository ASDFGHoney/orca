/**
 * React keys for the Cmd+J result list.
 *
 * Entry ids are built from persisted record ids (tab, worktree, project), and a
 * corrupt session can repeat one — an editor owner migration re-stamps a tab id
 * that a sibling record already carries. React keeps one fiber per key in its
 * reconciliation map, so a repeated key leaves the extra row with no fiber to
 * delete: it stays mounted forever, frozen at the query that last rendered it,
 * sitting above the live sections. Disambiguate here so the list never depends
 * on upstream ids being unique.
 */
export function buildPaletteListEntryRenderKeys(entryIds: readonly string[]): string[] {
  const used = new Set<string>()
  return entryIds.map((entryId) => {
    // Why keep the first key bare: stable ids must survive re-renders untouched.
    if (!used.has(entryId)) {
      used.add(entryId)
      return entryId
    }
    // Why probe: an entry id may itself already end in the suffix we append.
    let attempt = 1
    while (used.has(`${entryId}#dup${attempt}`)) {
      attempt += 1
    }
    const key = `${entryId}#dup${attempt}`
    used.add(key)
    return key
  })
}

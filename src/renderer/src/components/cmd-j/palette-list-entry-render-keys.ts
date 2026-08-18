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

/**
 * Why a reserved prefix rather than a `#dupN` suffix: a suffix generates keys in
 * the same namespace persisted ids live in, so the key minted for a second `a`
 * could equal a real sibling entry whose id IS `a#dup1`. Once a query narrows the
 * duplicate away React hands that key — and the row state behind it — to the real
 * entry. The prefix carves out a namespace no persisted id can reach, because an
 * id that already starts with it is escaped on the way in.
 *
 * Printable on purpose: these keys are also the rendered cmdk command values, and
 * HTML attribute parsing rewrites U+0000 to U+FFFD.
 */
const DUPLICATE_KEY_NAMESPACE = 'palette-dup:'

// Why prepend rather than strip: prepending is injective, and the result can never
// look generated because a generated key always has `\d+:` after the prefix.
function escapeReservedNamespace(entryId: string): string {
  return entryId.startsWith(DUPLICATE_KEY_NAMESPACE)
    ? `${DUPLICATE_KEY_NAMESPACE}${entryId}`
    : entryId
}

export function buildPaletteListEntryRenderKeys(entryIds: readonly string[]): string[] {
  const occurrences = new Map<string, number>()
  return entryIds.map((entryId) => {
    const occurrence = occurrences.get(entryId) ?? 0
    occurrences.set(entryId, occurrence + 1)
    const escaped = escapeReservedNamespace(entryId)
    // Why keep the first key bare: stable ids must survive re-renders untouched.
    // Later occurrences encode their index, so (id, occurrence) maps one-to-one to a key.
    return occurrence === 0 ? escaped : `${DUPLICATE_KEY_NAMESPACE}${occurrence}:${escaped}`
  })
}

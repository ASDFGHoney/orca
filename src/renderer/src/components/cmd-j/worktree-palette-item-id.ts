import type { PaletteSearchResult } from '@/lib/worktree-palette-search'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

export function buildWorktreePaletteItemIds(
  matches: readonly Pick<PaletteSearchResult, 'worktreeId' | 'worktreeHostId'>[]
): ReadonlyMap<string, string> {
  const countsById = new Map<string, number>()
  for (const match of matches) {
    countsById.set(match.worktreeId, (countsById.get(match.worktreeId) ?? 0) + 1)
  }
  return new Map(
    matches.map((match) => {
      const identity = composeWorktreeHostIdentity(match.worktreeHostId, match.worktreeId)
      const itemId =
        (countsById.get(match.worktreeId) ?? 0) > 1
          ? `worktree:${identity}`
          : `worktree:${match.worktreeId}`
      return [identity, itemId]
    })
  )
}

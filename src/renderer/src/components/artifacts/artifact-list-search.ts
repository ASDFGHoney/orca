import type { ArtifactListItem } from '../../../../shared/artifacts'
import { artifactName, artifactTypeLabel } from './artifact-display-labels'

export function artifactSearchHaystack(item: ArtifactListItem): string {
  return [
    artifactName(item),
    item.artifact.originalFileName,
    item.artifact.slug,
    artifactTypeLabel(item)
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase()
}

export function artifactMatchesSearchQuery(item: ArtifactListItem, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  return normalized === '' || artifactSearchHaystack(item).includes(normalized)
}

export function filterArtifactsBySearchQuery(
  artifacts: readonly ArtifactListItem[],
  query: string
): readonly ArtifactListItem[] {
  return artifacts.filter((item) => artifactMatchesSearchQuery(item, query))
}

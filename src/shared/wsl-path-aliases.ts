import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'

/**
 * Spellings of one path that Windows and WSL both use for the same files.
 *
 * Claude in a WSL pane records `/mnt/c/...` even when Orca's worktree is `C:\...`.
 * Distro-native repos already had the UNC → Linux alias; this adds the drvfs pair.
 */
export function wslPathAliases(pathValue: string): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    if (!value || seen.has(value)) {
      return
    }
    seen.add(value)
    aliases.push(value)
  }

  add(pathValue)

  const unc = parseWslUncPath(pathValue)
  if (unc) {
    add(unc.linuxPath)
  }

  const driveMatch = pathValue.match(/^([A-Za-z]):[/\\](.*)$/)
  if (driveMatch) {
    const rest = driveMatch[2].replace(/\\/g, '/')
    add(`/mnt/${driveMatch[1].toLowerCase()}${rest ? `/${rest}` : ''}`)
  }

  for (const candidate of aliases) {
    const mountMatch = candidate.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/)
    if (!mountMatch) {
      continue
    }
    const rest = (mountMatch[2] || '').replace(/\//g, '\\')
    add(`${mountMatch[1].toUpperCase()}:${rest || '\\'}`)
  }

  return aliases
}

export function normalizedWslPathAliases(pathValue: string): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const alias of wslPathAliases(pathValue)) {
    const normalized = normalizeRuntimePathForComparison(alias)
    if (seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    aliases.push(normalized)
  }
  return aliases
}

export function createWslAliasedPathInsideOrEqualMatcher(
  rootPath: string
): (normalizedCandidate: string) => boolean {
  const matchers = wslPathAliases(rootPath).map(createNormalizedPathInsideOrEqualMatcher)
  return (normalizedCandidate) => matchers.some((ownsPath) => ownsPath(normalizedCandidate))
}

export function isWslAliasedPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const ownsPath = createWslAliasedPathInsideOrEqualMatcher(rootPath)
  return normalizedWslPathAliases(candidatePath).some(ownsPath)
}

import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'

/**
 * Root spellings that explicitly identify one Windows/WSL filesystem path.
 *
 * Claude in a WSL pane records `/mnt/c/...` even when Orca's worktree is `C:\...`.
 * A raw `/mnt/c` root stays POSIX because its syntax alone does not prove WSL.
 */
export function wslRootPathAliases(pathValue: string): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  const add = (value: string | null) => {
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
    add(windowsDrivePathFromWslMount(unc.linuxPath))
  }

  add(wslMountPathFromWindowsDrive(pathValue))

  return aliases
}

/** Candidate spellings include a potential drive alias that only an explicit root can match. */
export function normalizedWslPathCandidateAliases(pathValue: string): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const alias of candidateWslPathAliases(pathValue)) {
    const normalized = normalizeRuntimePathForComparison(alias)
    if (seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    aliases.push(normalized)
  }
  return aliases
}

export function wslAliasedPathDepth(pathValue: string): number {
  const canonicalPath =
    parseWslUncPath(pathValue)?.linuxPath ?? wslMountPathFromWindowsDrive(pathValue) ?? pathValue
  return normalizeRuntimePathForComparison(canonicalPath).split('/').filter(Boolean).length
}

export function createWslAliasedPathInsideOrEqualMatcher(
  rootPath: string
): (normalizedCandidate: string) => boolean {
  const matchers = wslRootPathAliases(rootPath).map(createNormalizedPathInsideOrEqualMatcher)
  return (normalizedCandidate) => matchers.some((ownsPath) => ownsPath(normalizedCandidate))
}

export function isWslAliasedPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const ownsPath = createWslAliasedPathInsideOrEqualMatcher(rootPath)
  return normalizedWslPathCandidateAliases(candidatePath).some(ownsPath)
}

function candidateWslPathAliases(pathValue: string): string[] {
  const aliases = [pathValue]
  const linuxPath = parseWslUncPath(pathValue)?.linuxPath ?? pathValue
  const windowsPath = windowsDrivePathFromWslMount(linuxPath)
  return windowsPath ? [...aliases, windowsPath] : aliases
}

function wslMountPathFromWindowsDrive(pathValue: string): string | null {
  const match = pathValue.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!match) {
    return null
  }
  const rest = match[2].replace(/\\/g, '/')
  return `/mnt/${match[1].toLowerCase()}${rest ? `/${rest}` : ''}`
}

function windowsDrivePathFromWslMount(pathValue: string): string | null {
  const match = pathValue.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/)
  if (!match) {
    return null
  }
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return `${match[1].toUpperCase()}:${rest || '\\'}`
}

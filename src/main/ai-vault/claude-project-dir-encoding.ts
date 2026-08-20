import { normalizeRuntimePathSeparators } from '../../shared/cross-platform-path'

/**
 * Why: Claude derives the directory name from the raw cwd, so encoding from the
 * comparison key would lowercase Windows paths and never match on disk. Encode
 * the raw path, plus its NFC spelling, since macOS hands us NFD (#10832).
 */
export function encodeClaudeProjectPaths(pathValue: string): string[] {
  const raw = encodeClaudeProjectPath(pathValue)
  const composed = encodeClaudeProjectPath(pathValue.normalize('NFC'))
  return raw === composed ? [raw] : [raw, composed]
}

/** One dash per non-alphanumeric character — runs are NOT collapsed, so `/.claude` encodes to
 *  `--claude` and `C:\` to `c--`. Anything that collapses runs stops matching real buckets. */
export function encodeClaudeProjectPath(pathValue: string): string {
  const separated = normalizeRuntimePathSeparators(pathValue)
  const trimmed =
    separated === '/' || /^[A-Za-z]:\/$/.test(separated) ? separated : separated.replace(/\/+$/, '')
  return trimmed.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Encodings rooted at a Windows volume, either native (`c--Users-…`) or through WSL's
 *  drive automount (`-mnt-c-Users-…`). Those filesystems are case-insensitive, so the same
 *  worktree legitimately reaches us as `/mnt/c/Users/Neil` or `/mnt/c/users/neil`. */
const CASE_INSENSITIVE_ROOT_RE = /^(?:-mnt-[a-z]-|[a-z]--)/i

/** Why the explicit boundary: a bare `startsWith` lets a sibling prefix match, so the encoding of
 *  `…/orca` would claim `…/orca-secret` and `…/orcadyne` as its own.
 *
 *  Case handling is deliberately narrow: POSIX paths stay case-sensitive, but a prefix rooted at a
 *  Windows volume folds case, because encoding is done from the raw cwd (see above) and Windows
 *  spellings vary freely. Without this a WSL pane whose cwd was typed `/mnt/c/users/neil/orca` is
 *  dropped here, before the case-folding alias re-check ever runs. */
export function isClaudeProjectDirInScope(
  projectDirName: string,
  scopePrefixes: ReadonlySet<string> | readonly string[]
): boolean {
  for (const prefix of scopePrefixes) {
    if (projectDirName === prefix || projectDirName.startsWith(`${prefix}-`)) {
      return true
    }
    if (!CASE_INSENSITIVE_ROOT_RE.test(prefix)) {
      continue
    }
    const foldedPrefix = prefix.toLowerCase()
    const foldedDir = projectDirName.toLowerCase()
    if (foldedDir === foldedPrefix || foldedDir.startsWith(`${foldedPrefix}-`)) {
      return true
    }
  }
  return false
}

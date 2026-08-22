import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Shared file walk for the ratchet guards.
 *
 * Why one copy: four guards had grown their own `collectSourceFiles` /
 * `isTestFile` / allowlist reader, and they had already drifted -- one skipped
 * dot-directories and three did not, which is how the WSL separator guard came
 * to scan `tests/e2e/.cross-version-checkouts/` and report 21 offenders that
 * were copies of shipped releases. A guard that can be wrong about what it
 * scanned is worse than no guard, because its count is the goalpost.
 */

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])

/** Tests may do the thing the guard forbids; that is often why they exist. */
export function isTestFile(relativePath: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(relativePath) ||
    /(?:test-harness|test-utils|test-setup|test-fixture|repro)/.test(relativePath) ||
    relativePath.includes('/__tests__/')
  )
}

export type ScannedFile = { path: string; relativePath: string; source: string }

/**
 * Every `.ts`/`.tsx` file under `root`, with its text.
 *
 * Dot-directories are skipped: they hold generated and vendored trees (the
 * cross-version e2e checkouts among them), which are not ours to fix.
 */
export function scanSourceTree(root: string, options: { includeTests?: boolean } = {}): ScannedFile[] {
  const found: ScannedFile[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (IGNORED_DIRECTORIES.has(entry) || entry.startsWith('.') || entry === '__fixtures__') {
        continue
      }
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        visit(path)
        continue
      }
      if (!/\.tsx?$/.test(entry)) {
        continue
      }
      const relativePath = relative(root, path).replace(/\\/g, '/')
      if (!options.includeTests && isTestFile(relativePath)) {
        continue
      }
      found.push({ path, relativePath, source: readFileSync(path, 'utf8') })
    }
  }
  visit(root)
  return found
}

/** Read a ratchet allowlist, dropping comments and blanks. */
export function readAllowlist(fixturePath: string): string[] {
  return readFileSync(fixturePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** Comments blanked out, so a construct documented in prose is not counted as code. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

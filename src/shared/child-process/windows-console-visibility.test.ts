import { join, resolve } from 'node:path'
import {
  blankStringContents,
  blankStringContentsDesynced,
  readAllowlist,
  scanSourceTree,
  stripComments
} from '../source-scan/source-tree-scan'
import { describe, expect, it } from 'vitest'

/**
 * Every direct child-process call must pass `windowsHide`.
 *
 * Without it a GUI Electron process that spawns a console subsystem binary gets
 * a real console window: it flashes, and it steals foreground. On a git status
 * poll that is once per poll (#10488). `run-process.ts` sets the flag for
 * everything routed through it; this guards the calls that still spawn directly.
 *
 * The flag is inert off Windows, so this asks for it unconditionally rather than
 * making each site reason about its platform.
 *
 * The allowlist only shrinks — it is also the migration worklist. Removing a
 * file from it means either adding the flag or, better, routing the call
 * through the chokepoint.
 */
const ALLOWLIST: readonly string[] = readAllowlist(
  join(__dirname, '__fixtures__', 'windows-console-visibility-allowlist.txt')
)

const CHILD_PROCESS_IMPORT =
  /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]/
// Includes the promisified and renamed spellings -- `execAsync`, `spawnDetached`,
// `execFileCb` -- because a plain-name regex misses a `promisify(exec)` or an
// `import { spawn as sp }`, and those are real spawns.
const SPAWN_CALL =
  /\b(?:spawn|spawnSync|spawnDetached|execFile|execFileSync|execFileAsync|execFileCb|exec|execSync|execAsync)\s*\(/g
const SOURCE_ROOT = resolve(__dirname, '../..')




/** The call's argument text, brace-matched so a nested options literal stays whole. */
function readCallArguments(source: string, openParenIndex: number): string {
  let depth = 0
  for (let index = openParenIndex; index < source.length; index += 1) {
    if (source[index] === '(') {
      depth += 1
    } else if (source[index] === ')') {
      depth -= 1
      if (depth === 0) {
        return source.slice(openParenIndex, index)
      }
    }
  }
  return source.slice(openParenIndex)
}

function findOffenders(): string[] {
  const offenders = new Set<string>()
  for (const file of scanSourceTree(SOURCE_ROOT)) {
    const decommented = stripComments(file.source)
    // The import test needs the module name, which blanking would erase; the
    // call scan needs parens inside strings neutralised. Two views, one file.
    if (!CHILD_PROCESS_IMPORT.test(decommented)) {
      continue
    }
    // Fail closed: if the lexer lost its bearings, the scan below cannot be
    // trusted, so the file counts as an offender rather than as clean.
    if (blankStringContentsDesynced(decommented)) {
      offenders.add(file.relativePath)
      continue
    }
    const source = blankStringContents(decommented)
    for (const match of source.matchAll(SPAWN_CALL)) {
      const args = readCallArguments(source, match.index + match[0].length - 1)
      // `exec(command: string, …)` is a method declaration, not a spawn.
      if (/^\(\s*\w+\s*[:?]/.test(args)) {
        continue
      }
      if (!args.includes('windowsHide')) {
        offenders.add(file.relativePath)
      }
    }
  }
  return [...offenders].sort()
}

describe('direct child-process calls hide the Windows console', () => {
  const offenders = findOffenders()

  it('scans a realistic number of files', () => {
    // Guards against an import-pattern change quietly emptying the scan, which
    // would make every assertion below pass without checking anything.
    // Naming a file that definitely offends: `offenders + allowlist > N`
    // cannot fail while the allowlist alone exceeds N, so it passed even for a
    // scanner that found nothing.
    expect(offenders).toContain('main/wsl.ts')
  })

  it('adds no new file that spawns without windowsHide', () => {
    expect(offenders.filter((path) => !ALLOWLIST.includes(path))).toEqual([])
  })

  it('carries no stale allowlist entry', () => {
    // A fixed file must leave the list, or the ratchet stops ratcheting.
    expect(ALLOWLIST.filter((path) => !offenders.includes(path))).toEqual([])
  })
})

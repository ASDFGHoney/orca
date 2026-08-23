import { posix, win32 } from 'node:path'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  hasUnsupportedRevParsePathFormatEcho,
  isUnsupportedRevParsePathFormatError
} from '../../shared/git-worktree-command-capabilities'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import type { GitWorktreeExecOptions } from './worktree-execution-options'
import { gitWorktreeExecOptions } from './worktree-execution-options'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'

export function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform = process.platform
): boolean {
  if (platform === 'win32' || looksLikeWindowsPath(leftPath) || looksLikeWindowsPath(rightPath)) {
    return (
      win32.normalize(win32.resolve(leftPath)).toLowerCase() ===
      win32.normalize(win32.resolve(rightPath)).toLowerCase()
    )
  }
  return posix.normalize(posix.resolve(leftPath)) === posix.normalize(posix.resolve(rightPath))
}

export function translateWorktreePath(
  worktreePath: string,
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): string {
  const prefix = 'worktree '
  const translated = translateWslOutputPaths(`${prefix}${worktreePath}`, repoPath, options)
  return translated.startsWith(prefix) ? translated.slice(prefix.length) : worktreePath
}

export async function normalizeMainWorktreePath(
  repoPath: string,
  worktrees: GitWorktreeInfo[],
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const mainIndex = worktrees.findIndex((worktree) => worktree.isMainWorktree)
  const mainWorktree = worktrees[mainIndex]
  const wslRepo = parseWslUncPath(repoPath)
  const comparablePath = wslRepo ? wslRepo.linuxPath : repoPath
  if (!mainWorktree || areWorktreePathsEqual(mainWorktree.path, comparablePath)) {
    return worktrees
  }

  const location = await readRepoLocation(repoPath, comparablePath, options)
  if (!location || !areWorktreePathsEqual(mainWorktree.path, location.commonDir)) {
    return worktrees
  }

  const normalized = [...worktrees]
  normalized[mainIndex] = { ...mainWorktree, path: location.topLevel }
  return normalized
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

function resolveRevParsePath(repoPath: string, value: string): string {
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) {
    return value
  }
  return looksLikeWindowsPath(repoPath)
    ? win32.resolve(repoPath, value)
    : posix.resolve(repoPath, value)
}

type RepoLocation = { topLevel: string; commonDir: string }

function parseRepoLocation(repoPath: string, output: string): RepoLocation | undefined {
  const lines = output
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0 && !line.startsWith('-'))
  if (lines.length < 2) {
    return undefined
  }
  const [topLevel, commonDir] = lines.slice(-2)
  return {
    topLevel: resolveRevParsePath(repoPath, topLevel),
    commonDir: resolveRevParsePath(repoPath, commonDir)
  }
}

async function readRepoLocation(
  repoPath: string,
  resolveBasePath: string,
  options: GitWorktreeExecOptions
): Promise<RepoLocation | undefined> {
  try {
    return await withLocalGitCapabilityCacheForExecution(
      { cwd: repoPath, wslDistro: options.wslDistro, signal: options.signal },
      (capabilities) =>
        capabilities.runWithFallback(
          'rev-parse-path-format',
          async () => {
            const { stdout } = await gitExecFileAsync(
              ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
              gitWorktreeExecOptions(repoPath, options)
            )
            if (hasUnsupportedRevParsePathFormatEcho(stdout)) {
              capabilities.rememberUnsupported('rev-parse-path-format')
            }
            return parseRepoLocation(resolveBasePath, stdout)
          },
          async () => {
            const { stdout } = await gitExecFileAsync(
              ['rev-parse', '--show-toplevel', '--git-common-dir'],
              gitWorktreeExecOptions(repoPath, options)
            )
            return parseRepoLocation(resolveBasePath, stdout)
          },
          isUnsupportedRevParsePathFormatError
        )
    )
  } catch {
    return undefined
  }
}

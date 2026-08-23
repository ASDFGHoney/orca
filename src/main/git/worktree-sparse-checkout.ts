import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { resolveGitDir } from './conflict-status'

const DETECTION_CONCURRENCY = 8

export async function annotateSparseCheckoutStatus(
  worktrees: GitWorktreeInfo[]
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function detectNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      if (!worktree || worktree.isBare || worktree.isSparse) {
        continue
      }
      const isSparse = await detectSparseCheckout(worktree.path)
      if (isSparse) {
        annotated[index] = { ...worktree, isSparse }
      }
    }
  }

  const workerCount = Math.min(DETECTION_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => detectNext()))
  return annotated
}

async function detectSparseCheckout(worktreePath: string): Promise<boolean> {
  // The pattern file is the cheap fast-path; disabled sparse checkout leaves it behind,
  // so the effective config flag must also be checked.
  try {
    const gitDir = await resolveGitDir(worktreePath)
    const stats = await stat(join(gitDir, 'info', 'sparse-checkout'))
    if (!stats.isFile() || stats.size === 0) {
      return false
    }
    return await isSparseCheckoutEnabled(gitDir)
  } catch {
    return false
  }
}

async function resolveGitCommonDir(gitDir: string): Promise<string> {
  try {
    const raw = (await readFile(join(gitDir, 'commondir'), 'utf-8')).trim()
    if (raw.length > 0) {
      return isAbsolute(raw) ? raw : resolve(gitDir, raw)
    }
  } catch {
    // No commondir file means this gitdir is already the common directory.
  }
  return gitDir
}

async function isSparseCheckoutEnabled(gitDir: string): Promise<boolean> {
  const commonDir = await resolveGitCommonDir(gitDir)
  const sharedConfig = await readGitConfigText(join(commonDir, 'config'))
  const sharedFlag = parseCoreSparseCheckoutFlag(sharedConfig)
  if (parseGitConfigFlag(sharedConfig, 'extensions', 'worktreeconfig') !== true) {
    return sharedFlag ?? false
  }
  const worktreeConfig = await readGitConfigText(join(gitDir, 'config.worktree'))
  return parseCoreSparseCheckoutFlag(worktreeConfig) ?? sharedFlag ?? false
}

async function readGitConfigText(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, 'utf-8')
  } catch {
    return ''
  }
}

export function parseCoreSparseCheckoutFlag(configContent: string): boolean | undefined {
  return parseGitConfigFlag(configContent, 'core', 'sparsecheckout')
}

const SECTION_HEADER = /^\[\s*([A-Za-z0-9.-]+)(\s+"(?:[^"\\]|\\.)*")?\s*\]/
const ASSIGNMENT = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/

function parseGitConfigFlag(
  configContent: string,
  section: string,
  key: string
): boolean | undefined {
  let inSection = false
  let value: boolean | undefined
  for (const rawLine of configContent.split(/\r?\n/)) {
    let rest = stripGitConfigComment(rawLine).trim()
    for (let header = rest.match(SECTION_HEADER); header; header = rest.match(SECTION_HEADER)) {
      inSection = header[1].toLowerCase() === section && header[2] === undefined
      rest = rest.slice(header[0].length).trim()
    }
    if (!inSection || rest.length === 0) {
      continue
    }
    const assignment = rest.match(ASSIGNMENT)
    if (assignment?.[1].toLowerCase() === key) {
      value = parseGitConfigBoolean(assignment[2])
    }
  }
  return value
}

function stripGitConfigComment(line: string): string {
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"' && line[index - 1] !== '\\') {
      inQuotes = !inQuotes
    } else if ((char === '#' || char === ';') && !inQuotes) {
      return line.slice(0, index)
    }
  }
  return line
}

function parseGitConfigBoolean(raw: string | undefined): boolean {
  if (raw === undefined) {
    return true
  }
  const value = raw
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .toLowerCase()
  return value === 'true' || value === 'yes' || value === 'on' || value === '1'
}

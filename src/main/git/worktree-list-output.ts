import { decodeGitCQuotedPath } from '../../shared/git-cquoted-path'
import type { GitWorktreeInfo } from '../../shared/worktree/types'

/** Parse the porcelain output of `git worktree list --porcelain`. */
export function parseWorktreeList(
  output: string,
  options: { nulDelimited?: boolean } = {}
): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = []
  const blocks = options.nulDelimited ? splitNulWorktreeList(output) : splitLineWorktreeList(output)

  for (const lines of blocks) {
    if (lines.length === 0) {
      continue
    }

    let path = ''
    let head = ''
    let branch = ''
    let isBare = false
    let isSparse = false
    let locked = false
    let lockReason = ''
    let prunable = false
    let prunableReason = ''

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length)
      } else if (line === 'bare') {
        isBare = true
      } else if (line === 'sparse') {
        isSparse = true
      } else if (line === 'locked' || line.startsWith('locked ')) {
        locked = true
        const reason = line.slice('locked'.length).trim()
        lockReason = options.nulDelimited ? reason : decodeGitCQuotedPath(reason)
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        prunable = true
        const reason = line.slice('prunable'.length).trim()
        prunableReason = options.nulDelimited ? reason : decodeGitCQuotedPath(reason)
      }
    }

    if (path) {
      worktrees.push({
        path,
        head,
        branch,
        isBare,
        ...(isSparse ? { isSparse } : {}),
        ...(locked ? { locked: true } : {}),
        ...(lockReason ? { lockReason } : {}),
        ...(prunable ? { prunable: true } : {}),
        ...(prunableReason ? { prunableReason } : {}),
        isMainWorktree: worktrees.length === 0
      })
    }
  }
  return worktrees
}

function splitLineWorktreeList(output: string): string[][] {
  return output
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim().split(/\r?\n/))
}

function splitNulWorktreeList(output: string): string[][] {
  if (!output.includes('\0')) {
    return splitLineWorktreeList(output)
  }

  const blocks: string[][] = []
  let currentBlock: string[] = []
  for (const field of output.split('\0')) {
    if (field) {
      currentBlock.push(field)
    } else if (currentBlock.length > 0) {
      blocks.push(currentBlock)
      currentBlock = []
    }
  }
  if (currentBlock.length > 0) {
    blocks.push(currentBlock)
  }
  return blocks
}

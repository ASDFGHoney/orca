import type { GitBranchChangeEntry } from '../../shared/git-diff-compare-types'
import type { GitBranchChangeStatus } from '../../shared/git-status-types'
import { decodeGitCQuotedPath } from '../../shared/git-cquoted-path'

function parseBranchStatusChar(char: string): GitBranchChangeStatus {
  switch (char) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}
export function parseBranchChangeLine(line: string): GitBranchChangeEntry | null {
  const parts = line.split('\t')
  const rawStatus = parts[0] ?? ''
  const status = parseBranchStatusChar(rawStatus[0] ?? 'M')

  if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
    const oldPath = decodeGitCQuotedPath(parts[1] ?? '')
    const path = decodeGitCQuotedPath(parts[2] ?? '')
    if (!path) {
      return null
    }
    return { path, oldPath, status }
  }

  const path = decodeGitCQuotedPath(parts[1] ?? '')
  if (!path) {
    return null
  }

  return { path, status }
}

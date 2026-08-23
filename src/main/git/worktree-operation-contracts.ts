import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { GitWorktreeExecOptions } from './worktree-execution-options'

export type AddWorktreeResult = {
  localBaseRefRefresh?: LocalBaseRefRefreshResult
  localBaseRefUpdateSuggestion?: LocalBaseRefUpdateSuggestion
}

export type AddWorktreeOptions = GitWorktreeExecOptions & {
  checkoutExistingBranch?: boolean
  suggestLocalBaseRefUpdate?: boolean
  remoteTrackingBase?: {
    base: string
    branch: string
    ref: string
  }
}

export type RemoveWorktreeOptions = GitWorktreeExecOptions & {
  deleteBranch?: boolean
  forceBranchDelete?: boolean
  knownRemovedWorktree?: Pick<GitWorktreeInfo, 'branch' | 'head' | 'locked' | 'lockReason'>
}

export type WorktreeRemovalPreflightOptions = GitWorktreeExecOptions & {
  ignoredUntrackedPaths?: readonly string[]
}

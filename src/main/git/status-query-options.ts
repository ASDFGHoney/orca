import type { GitRuntimeOptions } from './git-runtime-options'

export type GetStatusOptions = GitRuntimeOptions & {
  includeIgnored?: boolean
  reuseLineStats?: boolean
  /** Merge-base OID the caller wants the branch line total measured against. */
  branchLineTotalMergeBase?: string
  /** Max changed-file entries; 0 disables the cap. */
  limit?: number
  bypassEffectiveUpstreamNegativeCache?: boolean
  /** Orca-managed shared links that may need filtering from untracked rows. */
  sharedLinkPaths?: readonly string[]
}

import type { GitDiffResult } from '../../shared/git-diff-compare-types'
import { InFlightPromiseDedupe, stableInFlightKey } from '../../shared/in-flight-promise-dedupe'
import type { GitRuntimeOptions } from './git-runtime-options'

const gitDiffReadDedupe = new InFlightPromiseDedupe<GitDiffResult>()

export function clearGitDiffReadCache(): void {
  gitDiffReadDedupe.clear()
}

export function runGitDiffRead(
  keyParts: readonly unknown[],
  options: GitRuntimeOptions,
  load: () => Promise<GitDiffResult>
): Promise<GitDiffResult> {
  return gitDiffReadDedupe.run(stableInFlightKey([...keyParts, options.wslDistro ?? null]), load)
}

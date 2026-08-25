import type { GitObjectPresence, PartialCloneVerdict } from '../../shared/git-object-store-failure'
import { readGitExecErrorText } from './git-exec-error-text'

/**
 * Failure-path-only diagnosis for a `worktree add` that died reading objects.
 *
 * Why not a preflight: peeling `^{tree}` costs a whole extra git process on every
 * create (measured at ~15 ms on a 2.9 GiB repo, the same as the `^{commit}` peel
 * it would sit next to) and still proves nothing about subtrees or blobs, so it
 * would slow every success for a partial guarantee. Git's own stderr from the
 * failed command is the authority; these probes only add detail after it fails.
 *
 * Git floor: `rev-parse --verify --quiet`, `<rev>^{commit}`, `<rev>^{tree}` and
 * `config --get-regexp` all long predate the 2.25 baseline, so no capability probe is needed.
 *
 * Executor-injected so the SSH path routes the same argv through the relay.
 */

export type WorktreeObjectStoreDiagnosis = {
  /** Needed to read `rootTree`: an unreadable commit fails the tree peel for its own reason. */
  commit: GitObjectPresence
  rootTree: GitObjectPresence
  partialClone: PartialCloneVerdict
}

type GitRunner = (args: string[]) => Promise<{ stdout: string }>

// Git's own diagnostics. Verified on 2.44.0: a genuinely absent object (or ref, or config
// key) exits 1 with EMPTY stderr, while an object that is present-but-unopenable exits 1
// *after* printing `error: unable to open loose object <oid>: Permission denied` (mode 000)
// or `error: object file <path> is empty` (truncated). Status 1 alone cannot tell them apart.
const GIT_DIAGNOSTIC_LINE = /^(?:error|fatal):/m

// Why silence too: `--quiet`/`--get-regexp` answer "no" with a *wordless* status 1. Any other
// status, an error carrying no status at all (dead SSH transport, killed process), or a status 1
// git explained on stderr means the probe never got an answer — and "we could not read it" must
// never be reported as "it is absent".
function gitAnsweredNo(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code !== 1) {
    return false
  }
  return !GIT_DIAGNOSTIC_LINE.test(readGitExecErrorText(error))
}

// Why peel both: `<rev>^{tree}` answers a silent "no" when the TREE is gone *and* when the
// COMMIT is gone (verified on git 2.44 with the commit object deleted: both peels exit 1 with
// empty stderr), so the tree peel alone cannot tell those apart. Only the pair does; callers
// must not read `rootTree` on its own.
async function probePeel(
  runGit: GitRunner,
  rev: string,
  peel: 'commit' | 'tree'
): Promise<GitObjectPresence> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', '--quiet', `${rev}^{${peel}}`])
    return stdout.trim().length > 0 ? 'present' : 'missing'
  } catch (error) {
    return gitAnsweredNo(error) ? 'missing' : 'unverifiable'
  }
}

async function probePartialClone(runGit: GitRunner): Promise<PartialCloneVerdict> {
  try {
    // Why promisor and not extensions.partialClone: current Git records the filter on the
    // remote (`remote.<name>.promisor`) and leaves the extension unset on fresh clones.
    const { stdout } = await runGit(['config', '--get-regexp', '^remote\\..*\\.promisor$'])
    return stdout.trim().length > 0 ? 'yes' : 'no'
  } catch (error) {
    return gitAnsweredNo(error) ? 'no' : 'unverifiable'
  }
}

export async function diagnoseWorktreeObjectStore(
  runGit: GitRunner,
  rev: string
): Promise<WorktreeObjectStoreDiagnosis> {
  const [commit, rootTree, partialClone] = await Promise.all([
    probePeel(runGit, rev, 'commit'),
    probePeel(runGit, rev, 'tree'),
    probePartialClone(runGit)
  ])
  return { commit, rootTree, partialClone }
}

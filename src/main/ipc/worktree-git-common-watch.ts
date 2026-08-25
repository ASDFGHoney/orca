import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { startGitCommonNarrowWatch } from './worktree-git-common-narrow-watch'
import { startGitCommonPrimaryWatch } from './worktree-git-common-primary-watch'
import { startGitCommonPolling } from './worktree-git-common-polling'

// Watches a repo's `<common>/.git/worktrees` metadata plus the primary
// checkout's shallow branch/index files — the only paths the git-common event
// filter consumes.
// macOS: a narrow native stream rooted at `worktrees/` — a tiny, rare-churn
// tree — gives instant detection with zero idle cost and zero wide-scope
// fseventsd delivery; the primary files are covered by a few stat calls per
// tick (a native stream would have to span the whole common dir, objects
// included). Other platforms: dir-listing poll (no fseventsd to protect, and
// on Windows an open directory handle on `worktrees/` could interfere with
// `git worktree prune` removing it).

export async function startGitCommonWatch(
  target: WorktreeBaseWatchTarget,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  platform: NodeJS.Platform,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  getStatusRefPaths: () => readonly string[] = () => [],
  onWatchError?: (error: Error) => void
): Promise<WorktreeBaseSubscription> {
  if (supportsNarrowWatch(platform)) {
    const [narrowWatch, primaryWatch] = await Promise.all([
      startGitCommonNarrowWatch(
        target,
        onEvents,
        pollIntervalMs,
        platform,
        visibility,
        onFullScan,
        onWatchError
      ),
      startGitCommonPrimaryWatch(
        target.path,
        getStatusRefPaths,
        onEvents,
        pollIntervalMs,
        visibility,
        onFullScan,
        onWatchError
      )
    ])
    return {
      unsubscribe: async () => {
        await Promise.all([narrowWatch.unsubscribe(), primaryWatch.unsubscribe()])
      }
    }
  }
  return startGitCommonPolling(
    target.path,
    onEvents,
    pollIntervalMs,
    visibility,
    onFullScan,
    true,
    getStatusRefPaths
  )
}

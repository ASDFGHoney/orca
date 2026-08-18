/**
 * Recognises a `HISTFILE` value Orca itself minted for a worktree.
 *
 * Why: HISTFILE is EXPORTED into the pane, so an Orca launched from an Orca
 * pane inherits the launching worktree's history path in `process.env`. Every
 * pane of the nested app then hits the check-before-set early return in
 * `injectHistoryEnv`, gets no injection of its own, and appends into that ONE
 * worktree's history file — per-worktree isolation silently off. Same bug class
 * as the inherited `fish_history` fixed in #15195, and the same shape of fix:
 * only a value Orca can prove it minted is dropped, so a HISTFILE the user set
 * deliberately still wins.
 *
 * Matching is on the path shape rather than a resolved root because the same
 * predicate has to work in three processes that cannot all compute the roots:
 * the desktop (Electron userData), the daemon subprocess (no Electron), and the
 * relay on a remote host. Desktop and relay drop each other's shapes on purpose
 * — neither owns the other's worktree ids.
 */

/** 16 hex chars: `hashWorktreeId`. */
const WORKTREE_HASH = '[0-9a-f]{16}'
const HISTORY_FILE = '(?:zsh|bash)_history'

const ORCA_MINTED_HISTFILE = new RegExp(
  '(?:^|/)(?:' +
    // Desktop: <userData>/terminal-history/<hash>/<file>
    `terminal-history/${WORKTREE_HASH}/${HISTORY_FILE}` +
    '|' +
    // Desktop WSL: <userData>/terminal-history-wsl/<distro>/<hash>/<file>,
    // which reaches the guest as the /mnt/<drive>/... form of the same tail.
    `terminal-history-wsl/[^/]+/${WORKTREE_HASH}/${HISTORY_FILE}` +
    '|' +
    // Relay: ~/.orca-remote/terminal-history/<hash>-<file>
    `\\.orca-remote/terminal-history/${WORKTREE_HASH}-${HISTORY_FILE}` +
    ')$'
)

export function isOrcaMintedHistFile(value: string | undefined): boolean {
  return typeof value === 'string' && ORCA_MINTED_HISTFILE.test(value.replace(/\\/g, '/'))
}

/** Drop a `HISTFILE` this process inherited from an outer Orca pane. */
export function dropInheritedOrcaHistFile(env: Record<string, string | undefined>): void {
  if (isOrcaMintedHistFile(env.HISTFILE)) {
    delete env.HISTFILE
  }
}

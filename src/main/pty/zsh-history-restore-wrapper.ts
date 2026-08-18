import { win32 as pathWin32 } from 'node:path'

/**
 * Whether a zsh PTY must launch through Orca's ZDOTDIR wrapper to keep the
 * worktree-scoped history it was given.
 *
 * Why: macOS `/etc/zshrc` (and several distro equivalents) assign
 * `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` with no check-before-set, and they
 * run before any file the user controls. The injected HISTFILE is therefore
 * already gone by the first prompt unless the wrapper restores it from
 * ORCA_HISTFILE afterwards (#11044). ORCA_HISTFILE is set only when this spawn
 * injected a scoped history, so this is false for panes Orca left alone.
 */
export function requiresZshHistoryRestoreWrapper(
  shellPath: string,
  env: Record<string, string | undefined>
): boolean {
  // Basename over resolveShellKind: the wrapper config keys off the exact name too.
  return Boolean(env.ORCA_HISTFILE) && pathWin32.basename(shellPath).toLowerCase() === 'zsh'
}

/**
 * Drops an ORCA_HISTFILE the spawning process inherited instead of one this
 * spawn injected.
 *
 * Why: Orca — or its daemon fork, or a relay server — started from inside an
 * Orca pane inherits that pane's exported ORCA_HISTFILE, and every merged spawn
 * env carries it forward. Left in place it makes the gate above true for a pane
 * whose history scoping is OFF, and the wrapper then points that pane at the
 * LAUNCHING worktree's history file. Credit: #11146.
 */
export function removeInheritedOrcaHistFile(
  env: Record<string, string>,
  requestedEnv: Record<string, string> | undefined
): void {
  if (!requestedEnv || !Object.hasOwn(requestedEnv, 'ORCA_HISTFILE')) {
    delete env.ORCA_HISTFILE
  }
}

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

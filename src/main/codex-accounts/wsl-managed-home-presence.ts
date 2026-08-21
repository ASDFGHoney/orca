import { buildEncodedWslBashCommand, quoteBashString } from '../wsl-bash-command'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'

export const WSL_MANAGED_HOME_ABSENT_STATUS = 2
export const WSL_MANAGED_HOME_UNREADABLE_STATUS = 13

export type WslManagedHomePresence = 'present' | 'absent' | 'unreadable'

export function buildWslManagedHomePresenceArgs(distro: string, linuxPath: string): string[] {
  const script = [
    'set -eu',
    `candidate=${quoteBashString(linuxPath)}`,
    'export LC_ALL=C',
    // Why: `[ -e ]` is 1 for both missing and EACCES. `stat` plus the C-locale
    // "No such file" suffix is the guest-side ENOENT vs everything-else split.
    'if err=$(stat -- "$candidate" 2>&1); then',
    '  exit 0',
    'fi',
    'case "$err" in',
    `  *"No such file or directory"*) exit ${String(WSL_MANAGED_HOME_ABSENT_STATUS)} ;;`,
    `  *) exit ${String(WSL_MANAGED_HOME_UNREADABLE_STATUS)} ;;`,
    'esac'
  ].join('\n')
  return buildWslExecArgs(distro, ['bash', '-c', buildEncodedWslBashCommand(script)])
}

export function buildWslManagedHomeCreateArgs(
  distro: string,
  linuxPath: string,
  accountId: string
): string[] {
  const script = [
    'set -euo pipefail',
    `candidate=${quoteBashString(linuxPath)}`,
    `expected_marker=${quoteBashString(accountId)}`,
    'mkdir -p -- "$candidate"',
    'printf "%s\\n" "$expected_marker" > "$candidate/.orca-managed-home"'
  ].join('\n')
  return buildWslExecArgs(distro, ['bash', '-c', buildEncodedWslBashCommand(script)])
}

export function classifyWslManagedHomeExecError(
  error: unknown
): Exclude<WslManagedHomePresence, 'present'> {
  const status =
    error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined
  return status === WSL_MANAGED_HOME_ABSENT_STATUS ? 'absent' : 'unreadable'
}

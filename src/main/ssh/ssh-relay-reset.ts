import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'

// Why: reset is the escape hatch a failed deploy points users at, so it must not repeat the
// displacement it exists to undo — unlinking a socket whose owner is still running orphans
// that relay and every PTY it holds (STA-1756). These markers report the two ways reset can
// fail to prove the owner is gone, so the caller can say so instead of silently leaking.
const RESET_NO_OWNER_PROOF_MARKER = 'ORCA-RELAY-RESET-NO-OWNER-PROOF'
const RESET_OWNER_SURVIVED_MARKER = 'ORCA-RELAY-RESET-OWNER-SURVIVED'

export async function forceStopRelayForTarget(
  conn: SshConnection,
  relayInstanceId: string
): Promise<void> {
  const sockName = relaySocketNameForInstanceId(relayInstanceId)
  const escapedSockName = shellEscape(sockName)
  const script = [
    `sock_name=${escapedSockName}`,
    'base="${HOME}/.orca-remote"',
    // Why: lsof ORs selectors by default; -a prevents reset from targeting
    // every Unix-socket holder instead of only the per-relay socket (#8762).
    'find_holder() {',
    '  holder=""',
    '  if command -v lsof >/dev/null 2>&1; then',
    '    holder=$(lsof -t -a -U "$1" 2>/dev/null | tr "\\n" " ")',
    '  fi',
    '  if [ -z "$holder" ] && command -v pgrep >/dev/null 2>&1; then',
    '    holder=$(pgrep -f "$sock_name" 2>/dev/null | ' +
      'awk -v self="$$" -v parent="$PPID" \'$1 != self && $1 != parent\' | tr "\\n" " ")',
    '  fi',
    '}',
    'if [ -d "$base" ]; then',
    '  for sock in "$base"/relay-*/"$sock_name" "$base"/"$sock_name"; do',
    '    [ -S "$sock" ] || continue',
    // Why: with neither tool the host offers no way to see an owner, and an unlink here
    // would strand a live relay rather than stop it.
    '    if ! command -v lsof >/dev/null 2>&1 && ! command -v pgrep >/dev/null 2>&1; then',
    `      echo ${RESET_NO_OWNER_PROOF_MARKER}`,
    '      continue',
    '    fi',
    '    find_holder "$sock"',
    '    if [ -n "$holder" ]; then',
    '      kill -TERM $holder 2>/dev/null || true',
    '      sleep 0.2',
    '      kill -KILL $holder 2>/dev/null || true',
    '      sleep 0.2',
    '    fi',
    // Why re-check: a refused kill (permissions, a wedged process) leaves the owner
    // listening, and removing its socket then hides it instead of stopping it.
    '    find_holder "$sock"',
    '    if [ -n "$holder" ]; then',
    `      echo ${RESET_OWNER_SURVIVED_MARKER}`,
    '      continue',
    '    fi',
    '    rm -f "$sock"',
    '  done',
    'fi'
  ].join('\n')

  const output = await execCommand(conn, script)
  if (output.includes(RESET_OWNER_SURVIVED_MARKER)) {
    throw new Error(
      'The remote relay is still running after the reset signal, so its socket was left in ' +
        'place rather than stranding it. Stop the relay process on the host, then retry.'
    )
  }
  if (output.includes(RESET_NO_OWNER_PROOF_MARKER)) {
    throw new Error(
      'This host has neither lsof nor pgrep, so the relay owning the socket could not be ' +
        'identified. The socket was left in place; stop the relay process on the host, then retry.'
    )
  }
}

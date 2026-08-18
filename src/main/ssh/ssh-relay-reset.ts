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

/**
 * Stop the relay owning this target's socket.
 *
 * Why it no longer removes the socket: a relay that stops cleanly unlinks its own path, and
 * one that had to be killed leaves an inode the next deploy releases under its identity
 * guard. Removing it here would need the same guard and would still race a relay binding the
 * path between the check and the unlink — for no gain, since the leftover inode blocks
 * nothing.
 */
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
    // Why an inventory rather than "no pid found": a lookup that returned nothing may
    // simply have been unable to look, and reset must not read that silence as a stop.
    // 0 = a process holds the socket, 1 = an inventory ran and none does, 2 = none ran.
    'socket_listed() {',
    // Why the columns are spelled out below: mawk, Debian's default awk, does not support
    // {n} interval expressions, and the strip silently matched nothing there.
    // Why awk on the eighth column rather than grep on the line: the pathname may contain
    // spaces and regex metacharacters, and an interpolated pattern would both over-match and
    // fail on a legal path. Why the exit-code split: a missing or failing tool answers
    // nothing, and reading that as "no owner" is the inference this change removes.
    '  if [ -r /proc/net/unix ] && command -v awk >/dev/null 2>&1; then',
    '    awk -v target="$1" \'NR>1{line=$0;' +
      'sub(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +/,"",line);' +
      "if(line==target){found=1}}END{exit(found?0:1)}' /proc/net/unix",
    '    case $? in 0) return 0 ;; 1) return 1 ;; *) return 2 ;; esac',
    '  fi',
    '  if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -t -p $$ 2>/dev/null)" ]; then',
    '    [ -n "$(lsof -t -a -U "$1" 2>/dev/null)" ] && return 0 || return 1',
    '  fi',
    '  return 2',
    '}',
    'if [ -d "$base" ]; then',
    '  for sock in "$base"/relay-*/"$sock_name" "$base"/"$sock_name"; do',
    '    [ -S "$sock" ] || continue',
    '    find_holder "$sock"',
    '    if [ -n "$holder" ]; then',
    '      kill -TERM $holder 2>/dev/null || true',
    '      sleep 0.2',
    '      kill -KILL $holder 2>/dev/null || true',
    '      sleep 0.2',
    '    fi',
    // Why re-check both: a refused kill (permissions, a wedged process) leaves the owner
    // running, and reporting success then tells the user a relay was stopped that was not.
    '    socket_listed "$sock"',
    '    listed=$?',
    '    find_holder "$sock"',
    '    if [ "$listed" = 0 ] || [ -n "$holder" ]; then',
    `      echo ${RESET_OWNER_SURVIVED_MARKER}`,
    // Why regardless of whether we signalled: sending a signal is not evidence the process
    // took it, so with no inventory to ask afterwards the stop stays unproven either way.
    '    elif [ "$listed" = 2 ]; then',
    `      echo ${RESET_NO_OWNER_PROOF_MARKER}`,
    '    fi',
    '  done',
    'fi'
  ].join('\n')

  const output = await execCommand(conn, script)
  if (output.includes(RESET_OWNER_SURVIVED_MARKER)) {
    throw new Error(
      'The remote relay is still running after the reset signal. Stop the relay process on ' +
        'the host, then retry.'
    )
  }
  if (output.includes(RESET_NO_OWNER_PROOF_MARKER)) {
    throw new Error(
      'This host offers no way to see which process owns the relay socket (no /proc/net/unix ' +
        'and no lsof), so nothing was stopped. Stop the relay process on the host, then retry.'
    )
  }
}

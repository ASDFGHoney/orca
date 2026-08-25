import type { IPty } from 'node-pty'
import { listPtyJobProcessIds } from '../windows/windows-pty-job'

type WindowsConptyMembershipDeps = {
  listJobProcessIds?: (proc: IPty) => readonly number[] | null
}

/**
 * Processes still running under a pane, or null when there is no answer.
 *
 * Read from the pane's Win32 job object, not from `GetConsoleProcessList`.
 * That API must be called from a process attached to the console, which is why
 * node-pty answered it by forking a helper — and why asking on a foreground
 * poll, per pane, accumulated hundreds of hidden `conpty_console_list_agent`
 * processes until the machine ran out of memory (#10857). Each read spawned a
 * process; killing them changed nothing because the next poll spawned more.
 *
 * `QueryInformationJobObject` has no such constraint: any process holding the
 * job handle can ask, so this is one syscall and zero children. Orca already
 * creates the job per PTY.
 *
 * Semantics callers rely on, unchanged by the switch:
 * - a root-only set proves the shell is alone, so a stale agent can be retired;
 * - `size > 1` proves something is still running under the shell.
 *
 * The one difference is that a descendant which detached from the console stays
 * in the job. That widens the set, which is the conservative direction for
 * every caller: it keeps a live agent rather than retiring it early.
 *
 * Null still means unverifiable per docs/reference/ssh-execution-boundary.md --
 * an unpatched node-pty, a non-ConPTY terminal, or a tree no longer tracked.
 * It is never evidence that processes died.
 */
export function readWindowsConptyProcessIds(
  proc: IPty,
  deps: WindowsConptyMembershipDeps = {}
): ReadonlySet<number> | null {
  const pids = (deps.listJobProcessIds ?? listPtyJobProcessIds)(proc)
  if (!pids) {
    return null
  }
  const membership = new Set<number>()
  for (const pid of pids) {
    if (Number.isSafeInteger(pid) && pid > 0) {
      membership.add(pid)
    }
  }
  // Why reject an empty set: the job answering with no members at all is not
  // the shell-alone case callers decide on -- it means the tree is gone, which
  // this function has never been the one to report.
  return membership.size > 0 ? membership : null
}

import type { IPty } from 'node-pty'
import { isPtyJobOwnershipAvailable, terminatePtyJob } from '../windows/windows-pty-job'

type HiddenPty = {
  kill: (signal?: string) => void
  destroy?: () => void
}

type Disposable = {
  dispose: () => void
}

const activeHiddenRateLimitPtys = new Set<HiddenPty>()

export function registerHiddenRateLimitPty(term: HiddenPty): Disposable {
  activeHiddenRateLimitPtys.add(term)
  return {
    dispose: () => {
      activeHiddenRateLimitPtys.delete(term)
    }
  }
}

export function getActiveHiddenRateLimitPtyCount(): number {
  return activeHiddenRateLimitPtys.size
}

/** Uses bundled ConPTY only when cleanup can terminate the exact PTY job. */
export function windowsHiddenPtySpawnOptions(): { useConptyDll: true } | Record<string, never> {
  return process.platform === 'win32' && isPtyJobOwnershipAvailable() ? { useConptyDll: true } : {}
}

export function cleanupHiddenRateLimitPty(
  term: HiddenPty,
  disposables: Disposable[],
  options: { kill: boolean }
): void {
  for (const disposable of disposables.splice(0)) {
    disposable.dispose()
  }

  if (process.platform === 'win32') {
    terminatePtyJob(term as IPty)
  }

  if (options.kill) {
    try {
      term.kill()
    } catch {
      /* already exited */
    }

    // Why: node-pty WindowsTerminal.destroy() calls kill() again, which can
    // close the same ConPTY handle twice after an intentional termination.
    if (process.platform === 'win32') {
      return
    }
  }

  // Why: node-pty destroy releases the master PTY fd; on POSIX, neutralize
  // the post-close SIGHUP hook after exit/kill to avoid pid reuse.
  if (process.platform !== 'win32') {
    term.kill = () => {}
  }
  try {
    term.destroy?.()
  } catch {
    /* already torn down */
  }
}

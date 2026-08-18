// Why: a unique error class so callers (in particular the relay-lost retry
// loop in src/main/ipc/ssh.ts) can branch on `instanceof
// RelayVersionMismatchError` and treat the failure as terminal — i.e. skip
// the exponential-backoff retry and surface a user-visible "please reconnect
// manually" error. Any other transport failure remains transiently retryable.
//
// Trigger: the remote `--connect` process exits with code 42 after the
// daemon's wire-level handshake reports a version mismatch. See
// docs/ssh-relay-versioned-install-dirs.md.

export class RelayVersionMismatchError extends Error {
  readonly name = 'RelayVersionMismatchError'

  constructor(
    readonly expected: string | undefined,
    readonly got: string | undefined,
    readonly stderr?: string
  ) {
    super(
      `Remote relay version mismatch — expected=${expected ?? 'unknown'}, ` +
        `daemon=${got ?? 'unknown'}. The remote daemon was launched against a different ` +
        `relay binary than the local client expects. Please reconnect manually.`
    )
  }
}

// Why bounded: causes are attacker-free but not cycle-free, and a plain recursion over a
// self-referential chain would hang the connect path instead of failing it.
const MAX_CAUSE_DEPTH = 8

/**
 * True for a mismatch reported directly, or carried as the cause of a wrapper.
 *
 * Why unwrap: a reconnect refused by a live daemon surfaces as a socket-owner error whose
 * cause is this one, and a version the daemon cannot change is no more reconcilable by
 * backoff there than it is here (STA-1756).
 */
export function isRelayVersionMismatchError(err: unknown): err is Error {
  let current = err
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof RelayVersionMismatchError) {
      return true
    }
    if (!(current instanceof Error) || current.cause === undefined) {
      return false
    }
    current = current.cause
  }
  return false
}

// Why: the remote --connect process uses this exit code to signal the wire
// handshake failed because of a version mismatch. The mapping daemon ⇄ exit
// code 42 lives in src/relay/relay-handshake.ts (EXIT_CODE_VERSION_MISMATCH).
export const RELAY_EXIT_CODE_VERSION_MISMATCH = 42

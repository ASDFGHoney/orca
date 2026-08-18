import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'

/**
 * Who owns a relay socket path, as observed from the client.
 *
 * The vocabulary is pinned by docs/reference/ssh-execution-boundary.md:
 * `exited` requires positive evidence of absence, and anything we could not
 * observe stays `unverifiable` — never collapsed into either neighbour.
 * Here the subject is the socket path: `exited` means the connect attempt was
 * actively refused, so no process is listening at that path any more.
 */
export type RelaySocketOwnerVerdict = 'live' | 'exited' | 'unverifiable'

const PROBE_TIMEOUT_MS = 3_000

// Why: probe via node (guaranteed present on the host — it is what runs the relay)
// rather than lsof/fuser/socat, which vary by distro and are often absent.
// Why: `test -S` only proves the inode exists; a connect-and-close is the only
// thing that separates a listening owner from an inode a crashed relay left behind.
const RELAY_SOCKET_OWNER_PROBE_SCRIPT =
  'var net=require("net"),done=false,' +
  'say=function(v){if(done)return;done=true;clearTimeout(t);process.stdout.write(v);s.destroy()},' +
  's=net.connect(process.argv[1]),' +
  `t=setTimeout(function(){say("UNVERIFIABLE")},${PROBE_TIMEOUT_MS});` +
  's.on("connect",function(){say("LIVE")});' +
  's.on("error",function(e){say(e.code==="ECONNREFUSED"||e.code==="ENOENT"?"EXITED":"UNVERIFIABLE")})'

export function relaySocketOwnerProbeCommand(nodePath: string, sockPath: string): string {
  // Why: pass the socket path as argv[1] rather than interpolating it into -e, to dodge quoting issues.
  return `${shellEscape(nodePath)} -e ${shellEscape(RELAY_SOCKET_OWNER_PROBE_SCRIPT)} ${shellEscape(sockPath)}`
}

export function parseRelaySocketOwnerProbe(output: string): RelaySocketOwnerVerdict {
  const markers = new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line === 'LIVE' || line === 'EXITED' || line === 'UNVERIFIABLE')
  )
  if (markers.size !== 1) {
    return 'unverifiable'
  }
  if (markers.has('LIVE')) {
    return 'live'
  }
  return markers.has('EXITED') ? 'exited' : 'unverifiable'
}

export async function probeRelaySocketOwner(
  conn: SshConnection,
  nodePath: string,
  sockPath: string,
  signal?: AbortSignal
): Promise<RelaySocketOwnerVerdict> {
  try {
    return parseRelaySocketOwnerProbe(
      await execCommand(conn, relaySocketOwnerProbeCommand(nodePath, sockPath), { signal })
    )
  } catch {
    // Why: a probe we could not run answers nothing about the owner, and the
    // caller must not treat that silence as death.
    signal?.throwIfAborted()
    return 'unverifiable'
  }
}

export class RelaySocketOwnerLiveError extends Error {
  readonly name = 'RelaySocketOwnerLiveError'

  constructor(
    readonly sockPath: string,
    readonly verdict: Exclude<RelaySocketOwnerVerdict, 'exited'>,
    readonly cause?: unknown
  ) {
    super(
      `Could not reach the relay at ${sockPath}, and its socket is ${
        verdict === 'live' ? 'still owned by a running relay' : 'of unproven ownership'
      }. Leaving it in place — replacing it would strand that relay and every terminal it holds. ` +
        'Retry, or use "Reset remote relay" on the SSH target to stop it.'
    )
  }
}

export function isRelaySocketOwnerLiveError(err: unknown): err is RelaySocketOwnerLiveError {
  return err instanceof RelaySocketOwnerLiveError
}

/**
 * Remove a relay socket so a fresh daemon can bind the same path — but only
 * once the probe proves nothing is listening there.
 *
 * Why this gate: unlinking cannot stop a relay that already bound the path. It
 * only hides the live owner from the fresh launch's EADDRINUSE stale-socket
 * check, which is the one interlock that refuses to displace a running daemon.
 * A failed `--connect` is loss of contact, never proof of death (STA-1756).
 */
export async function removeUnownedRelaySocket(
  conn: SshConnection,
  nodePath: string,
  sockPath: string,
  options?: { signal?: AbortSignal; cause?: unknown }
): Promise<void> {
  const signal = options?.signal
  const verdict = await probeRelaySocketOwner(conn, nodePath, sockPath, signal)
  signal?.throwIfAborted()
  if (verdict !== 'exited') {
    throw new RelaySocketOwnerLiveError(sockPath, verdict, options?.cause)
  }
  await execCommand(conn, `rm -f ${shellEscape(sockPath)}`, { signal }).catch((cleanupErr) => {
    if (isUnconfirmedSshCommandTermination(cleanupErr)) {
      throw cleanupErr
    }
  })
  signal?.throwIfAborted()
}

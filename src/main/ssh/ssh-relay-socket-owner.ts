import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'

/**
 * What happened when we asked the host to release a relay socket path.
 *
 * The vocabulary follows `src/shared/pty-liveness-verdict.ts`: `released` needs
 * positive evidence that nothing owns the path, and anything we could not
 * observe stays `unverifiable` — never read as absence.
 */
export type RelaySocketReleaseOutcome = 'live' | 'released' | 'unverifiable'

const PROBE_TIMEOUT_MS = 3_000
const PROBE_ATTEMPTS = 3
const PROBE_RETRY_MS = 250

// Why one host-side script rather than probe-then-remove from here: an SSH round-trip
// between the two is wide enough for another client to bind the path, and the removal
// would then unlink a live owner's socket. The unlink is guarded by the same
// dev+ino+ctime identity the relay uses for its own stale-socket cleanup (relay.ts
// unlinkIfStillStale).
//
// Why refusals alone never authorize the unlink: a live Unix listener whose accept
// backlog is full also answers ECONNREFUSED, so N refusals are an inference, not the
// positive evidence of absence this whole change is about. The unlink additionally
// requires an owner inventory that ran and did not list the path — /proc/net/unix where
// it exists, otherwise an lsof that ran and matched nothing. With neither, the answer is
// unverifiable and the socket stays.
const RELAY_SOCKET_RELEASE_SCRIPT =
  'var net=require("net"),fs=require("fs"),p=process.argv[1],lsofProof=process.argv[2]==="lsof",' +
  `left=${PROBE_ATTEMPTS},mark=null,done=false,sock=null,timer=null;` +
  // "live" if an inventory lists the path, "absent" if one ran without it, null if none ran.
  // Why the field strip rather than a suffix test: the pathname is everything after the
  // seventh column, so a socket whose own path ends with " " + ours would match a suffix.
  'function inventory(){var data;try{data=fs.readFileSync("/proc/net/unix","utf8")}' +
  'catch(e){return lsofProof?"absent":null}' +
  'var lines=data.split(String.fromCharCode(10));' +
  'for(var i=1;i<lines.length;i++){' +
  'if(lines[i].replace(/^(?:[^ ]+ +){7}/,"")===p){return "live"}}' +
  'return "absent"}' +
  // Why ctime too: inode numbers are recycled, so dev+ino alone can match a socket that
  // was unlinked and recreated inside the probe window. Same identity as relay.ts.
  'function ident(){try{var st=fs.statSync(p,{bigint:true});' +
  'return st.dev+":"+st.ino+":"+st.ctimeNs}catch(e){return null}}' +
  'function say(v){if(done)return;done=true;if(timer)clearTimeout(timer);' +
  'if(sock)sock.destroy();process.stdout.write(v)}' +
  'function release(){if(mark===null){say("RELEASED");return}' +
  'if(ident()!==mark){say("UNVERIFIABLE");return}' +
  'try{fs.unlinkSync(p)}catch(e){if(e.code!=="ENOENT"){say("UNVERIFIABLE");return}}say("RELEASED")}' +
  'function attempt(){mark=ident();sock=net.connect(p);' +
  `timer=setTimeout(function(){say("UNVERIFIABLE")},${PROBE_TIMEOUT_MS});` +
  'sock.on("connect",function(){say("LIVE")});' +
  'sock.on("error",function(e){clearTimeout(timer);' +
  'if(e.code==="ENOENT"){say("RELEASED");return}' +
  'if(e.code!=="ECONNREFUSED"){say("UNVERIFIABLE");return}' +
  `if(--left>0){setTimeout(attempt,${PROBE_RETRY_MS});return}` +
  'var inv=inventory();' +
  'if(inv==="live"){say("LIVE");return}' +
  'if(inv===null){say("UNVERIFIABLE");return}' +
  'release()})}attempt()'

export function relaySocketReleaseCommand(nodePath: string, sockPath: string): string {
  // Why lsof first: on hosts without /proc it is the only owner inventory available, and it
  // answers both ways — a match proves an owner is there, and a clean run that matches
  // nothing is the absence evidence the unlink needs. A missing lsof proves neither.
  // Why -a: lsof ORs selectors by default, which would match every Unix-socket holder (#8762).
  return (
    `sock=${shellEscape(sockPath)}; holders=; proof=none; ` +
    // Why probe lsof against our own process first: an lsof that is present but cannot
    // inspect anything reports nothing, and reading that silence as "no owner" is the
    // inference this whole change exists to remove. The relay runs as this same user, so
    // an lsof that can see our files can see its socket.
    'if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -t -p $$ 2>/dev/null)" ]; then ' +
    'holders=$(lsof -t -a -U "$sock" 2>/dev/null); [ -n "$holders" ] || proof=lsof; fi; ' +
    'if [ -n "$holders" ]; then echo LIVE; ' +
    // Why argv: passing the path and proof as arguments dodges quoting issues inside -e.
    `else ${shellEscape(nodePath)} -e ${shellEscape(RELAY_SOCKET_RELEASE_SCRIPT)} "$sock" "$proof"; fi`
  )
}

export function parseRelaySocketReleaseOutcome(output: string): RelaySocketReleaseOutcome {
  const markers = new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line === 'LIVE' || line === 'RELEASED' || line === 'UNVERIFIABLE')
  )
  if (markers.size !== 1) {
    return 'unverifiable'
  }
  if (markers.has('LIVE')) {
    return 'live'
  }
  return markers.has('RELEASED') ? 'released' : 'unverifiable'
}

export class RelaySocketOwnerLiveError extends Error {
  readonly name = 'RelaySocketOwnerLiveError'

  constructor(
    readonly sockPath: string,
    readonly outcome: Exclude<RelaySocketReleaseOutcome, 'released'>,
    cause?: unknown
  ) {
    super(
      `Could not reach the relay at ${sockPath}, and its socket is ${
        outcome === 'live' ? 'still owned by a running relay' : 'of unproven ownership'
      }. Leaving it in place — replacing it would strand that relay and every terminal it ` +
        `holds. Retry, or use "Reset remote relay" on the SSH target to stop it.${
          cause instanceof Error ? ` Reconnect failed with: ${cause.message}` : ''
        }`,
      { cause }
    )
  }
}

export function isRelaySocketOwnerLiveError(err: unknown): err is RelaySocketOwnerLiveError {
  return err instanceof RelaySocketOwnerLiveError
}

/**
 * Release a relay socket path so a fresh daemon can bind it — and only when the host
 * proves nothing owns it.
 *
 * Why the guard: unlinking cannot stop a relay that already bound the path. It only hides
 * the live owner from the fresh launch's EADDRINUSE check, which is the one interlock that
 * refuses to displace a running daemon. A failed `--connect` is loss of contact, never
 * proof of death (STA-1756).
 *
 * POSIX hosts only: Windows relays take the named-pipe path in launchWindowsRelay, where
 * there is no inode to unlink.
 */
export async function releaseUnownedRelaySocket(
  conn: SshConnection,
  nodePath: string,
  sockPath: string,
  options?: { signal?: AbortSignal; cause?: unknown }
): Promise<void> {
  const signal = options?.signal
  let outcome: RelaySocketReleaseOutcome
  try {
    outcome = parseRelaySocketReleaseOutcome(
      await execCommand(conn, relaySocketReleaseCommand(nodePath, sockPath), { signal })
    )
  } catch (err) {
    signal?.throwIfAborted()
    // Why rethrow: an unconfirmed close means the removal may still be in flight, and the
    // caller must not launch a relay over a path whose state it cannot describe.
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    // Why: a command we could not run says nothing about the owner, and the caller must not
    // read that silence as death.
    outcome = 'unverifiable'
  }
  signal?.throwIfAborted()
  if (outcome !== 'released') {
    throw new RelaySocketOwnerLiveError(sockPath, outcome, options?.cause)
  }
}

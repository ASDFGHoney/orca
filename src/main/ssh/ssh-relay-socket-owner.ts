import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'

/**
 * Who owns a relay socket path, as observed from the client.
 *
 * The vocabulary follows `src/shared/pty-liveness-verdict.ts`: `exited` needs positive
 * evidence that nothing owns the path, and anything we could not observe stays
 * `unverifiable` — never read as absence.
 */
export type RelaySocketOwnerVerdict = 'live' | 'exited' | 'unverifiable'

const PROBE_TIMEOUT_MS = 3_000
const PROBE_ATTEMPTS = 3
const PROBE_RETRY_MS = 250

// Why this only looks: the fresh daemon reclaims a stale path itself, checking the socket's
// identity and binding in one process (relay.ts unlinkIfStillStale). Unlinking here would
// put an SSH round-trip between that check and the launch, and a relay that bound the path
// in between would be the one we displaced.
//
// Why refusals alone are not absence: a live Unix listener whose accept backlog is full also
// answers ECONNREFUSED, so N refusals are an inference. A verdict of `exited` additionally
// needs an owner inventory that ran and did not list the path — /proc/net/unix where it
// exists, otherwise an lsof proven able to inspect this user's own processes.
const RELAY_SOCKET_OWNER_PROBE_SCRIPT =
  'var net=require("net"),fs=require("fs"),p=process.argv[1],lsofProof=process.argv[2]==="lsof",' +
  `left=${PROBE_ATTEMPTS},done=false,sock=null,timer=null;` +
  // "live" if an inventory lists the path, "exited" if one ran without it, null if none ran.
  // Why the column strip rather than a suffix test: the pathname is everything after the
  // seventh column, so a socket whose own path ends with " " + ours would match a suffix.
  'function inventory(){var data;try{data=fs.readFileSync("/proc/net/unix","utf8")}' +
  'catch(e){return lsofProof?"exited":null}' +
  'var lines=data.split(String.fromCharCode(10));' +
  'for(var i=1;i<lines.length;i++){' +
  'if(lines[i].replace(/^(?:[^ ]+ +){7}/,"")===p){return "live"}}' +
  'return "exited"}' +
  'function say(v){if(done)return;done=true;if(timer)clearTimeout(timer);' +
  'if(sock)sock.destroy();process.stdout.write(v)}' +
  'function attempt(){sock=net.connect(p);' +
  `timer=setTimeout(function(){say("UNVERIFIABLE")},${PROBE_TIMEOUT_MS});` +
  'sock.on("connect",function(){say("LIVE")});' +
  'sock.on("error",function(e){clearTimeout(timer);' +
  'if(e.code==="ENOENT"){say("EXITED");return}' +
  'if(e.code!=="ECONNREFUSED"){say("UNVERIFIABLE");return}' +
  `if(--left>0){setTimeout(attempt,${PROBE_RETRY_MS});return}` +
  'var inv=inventory();' +
  'say(inv==="live"?"LIVE":inv==="exited"?"EXITED":"UNVERIFIABLE")})}attempt()'

export function relaySocketOwnerProbeCommand(nodePath: string, sockPath: string): string {
  // Why ask lsof about our own process first: an lsof that is present but cannot inspect
  // anything reports nothing, and reading that silence as "no owner" is the inference this
  // whole change removes. The relay runs as this same user, so an lsof that can see our
  // files can see its socket.
  // Why -a: lsof ORs selectors by default, which would match every Unix-socket holder (#8762).
  return (
    `sock=${shellEscape(sockPath)}; holders=; proof=none; ` +
    'if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -t -p $$ 2>/dev/null)" ]; then ' +
    'holders=$(lsof -t -a -U "$sock" 2>/dev/null); [ -n "$holders" ] || proof=lsof; fi; ' +
    'if [ -n "$holders" ]; then echo LIVE; ' +
    // Why argv: passing the path and proof as arguments dodges quoting issues inside -e.
    `else ${shellEscape(nodePath)} -e ${shellEscape(RELAY_SOCKET_OWNER_PROBE_SCRIPT)} "$sock" "$proof"; fi`
  )
}

export function parseRelaySocketOwnerVerdict(output: string): RelaySocketOwnerVerdict {
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

export class RelaySocketOwnerLiveError extends Error {
  readonly name = 'RelaySocketOwnerLiveError'

  constructor(
    readonly sockPath: string,
    readonly verdict: Exclude<RelaySocketOwnerVerdict, 'exited'>,
    cause?: unknown
  ) {
    super(
      `Could not reach the relay at ${sockPath}, and its socket is ${
        verdict === 'live' ? 'still owned by a running relay' : 'of unproven ownership'
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
 * Establish that nothing owns this relay socket, so a fresh daemon may take the path.
 *
 * Why this gate: a failed `--connect` is loss of contact, never proof of death. Launching
 * over a path whose owner is still listening cannot stop that owner — it only hides it from
 * the fresh daemon's EADDRINUSE check, and it keeps running with its PTYs forever
 * (STA-1756). Reclaiming the path itself is the daemon's job, which it does under its own
 * identity check.
 *
 * POSIX hosts only: Windows relays take the named-pipe path in launchWindowsRelay.
 */
export async function requireUnownedRelaySocket(
  conn: SshConnection,
  nodePath: string,
  sockPath: string,
  options?: { signal?: AbortSignal; cause?: unknown }
): Promise<void> {
  const signal = options?.signal
  let verdict: RelaySocketOwnerVerdict
  try {
    verdict = parseRelaySocketOwnerVerdict(
      await execCommand(conn, relaySocketOwnerProbeCommand(nodePath, sockPath), { signal })
    )
  } catch {
    signal?.throwIfAborted()
    // Why: a probe we could not run says nothing about the owner, and the caller must not
    // read that silence as death.
    verdict = 'unverifiable'
  }
  signal?.throwIfAborted()
  if (verdict !== 'exited') {
    throw new RelaySocketOwnerLiveError(sockPath, verdict, options?.cause)
  }
}

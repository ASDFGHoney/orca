import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'
import { runProcess, runProcessSync } from '../shared/child-process/run-process'

export const AMPHETAMINE_BUNDLE_ID = 'com.if.Amphetamine'
export const MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS = 10_000
/** Quit blocks on this synchronously, and spawnSync cannot be preempted by the
 *  teardown deadline race, so it must stay far below it. */
export const MACOS_AMPHETAMINE_QUIT_TIMEOUT_MS = 2_000

const OSASCRIPT = '/usr/bin/osascript'

/**
 * Amphetamine's session is a single global one, not a per-process assertion:
 * `start new session` documents that it "ends any existing sessions, including
 * Trigger-based sessions". So every write here is preceded by a read in the same
 * script, and a session is only ended after it was seen to match the shape Orca
 * creates. That is a shape match, not proof of provenance — Amphetamine exposes
 * no session identity. See docs/reference/macos-keep-awake-engines.md.
 */
/**
 * Check and start from ONE osascript invocation.
 *
 * NOT a transaction. `tell` is client-side routing: AppleScript sends every
 * property read and every command as its own Apple event, and Amphetamine
 * offers no compare-and-swap, so an interleaving write is still possible. What
 * this buys is a much smaller window — the check and the start are consecutive
 * Apple events rather than separate process spawns tens of milliseconds apart.
 * The residual race is documented in docs/reference/macos-keep-awake-engines.md.
 *
 * duration 0 + interval 0 is the documented indefinite session. Omitting options
 * instead inherits the user's default duration, which silently expires.
 */
export const AMPHETAMINE_ACQUIRE_SCRIPT = `tell application id "${AMPHETAMINE_BUNDLE_ID}"
	if session is active then
		if session is Trigger then return "foreign"
		if (session time remaining) is not 0 then return "foreign"
		if not (display sleep allowed) then return "foreign"
		return "orca-shaped"
	end if
	start new session with options {duration:0, interval:0, displaySleepAllowed:true}
	return "started"
end tell`

/**
 * Verify and end from ONE osascript invocation.
 *
 * Same caveat as the acquire script: consecutive Apple events, not a
 * transaction. The shape test lives here rather than in TypeScript so the last
 * check is the Apple event immediately before `end session`, which is the
 * smallest window this API allows. "foreign" means the live session does not
 * match the shape Orca creates — timed, Trigger-driven, app/date-based, or
 * blocking display sleep — so it is left alone. Guarded by `is running` so
 * releasing never launches the app.
 */
export const AMPHETAMINE_RELEASE_SCRIPT = `if application id "${AMPHETAMINE_BUNDLE_ID}" is running then
	tell application id "${AMPHETAMINE_BUNDLE_ID}"
		if not (session is active) then return "gone"
		if session is Trigger then return "foreign"
		if (session time remaining) is not 0 then return "foreign"
		if not (display sleep allowed) then return "foreign"
		end session
		return "ended"
	end tell
else
	return "gone"
end if`

export const AMPHETAMINE_LOCATE_SCRIPT = `POSIX path of (path to application id "${AMPHETAMINE_BUNDLE_ID}")`

export type OsascriptResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type RunOsascript = (script: string, signal?: AbortSignal) => Promise<OsascriptResult>

/** What the acquire script did. */
/**
 * 'orca-shaped' matches what Orca creates. Usually that is Orca's own session,
 * still held or leaked by a process that was killed, and reclaiming it is the
 * only way it ever gets cleaned up. It can equally be a user session that
 * happens to match; the two are indistinguishable, which is the accepted
 * identity limit rather than something the code can resolve.
 */
export type AmphetamineAcquireOutcome = 'started' | 'orca-shaped' | 'foreign'
/** What the release script did. 'foreign' means the live session does not match Orca's shape. */
export type AmphetamineReleaseOutcome = 'ended' | 'foreign' | 'gone'

export function parseAcquireOutcome(stdout: string): AmphetamineAcquireOutcome | null {
  const value = stdout.trim()
  return value === 'started' || value === 'orca-shaped' || value === 'foreign' ? value : null
}

export function parseReleaseOutcome(stdout: string): AmphetamineReleaseOutcome | null {
  const value = stdout.trim()
  return value === 'ended' || value === 'foreign' || value === 'gone' ? value : null
}
export type RunOsascriptSync = (script: string) => OsascriptResult

export function runOsascriptWithRunProcess(
  script: string,
  signal?: AbortSignal
): Promise<OsascriptResult> {
  return runProcess({
    program: OSASCRIPT,
    args: ['-e', script],
    timeoutMs: MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS,
    signal
  })
}

export function runOsascriptSyncWithRunProcess(script: string): OsascriptResult {
  return runProcessSync({
    program: OSASCRIPT,
    args: ['-e', script],
    timeoutMs: MACOS_AMPHETAMINE_QUIT_TIMEOUT_MS
  })
}

/**
 * Resolve the bundle through Launch Services.
 *
 * Returns undefined when the answer is unknown — a timeout, a spawn error, or an
 * unrecognized failure. Only a lookup that positively failed to resolve the
 * bundle reports false, because a caller that records false disables the engine
 * and would otherwise do so on a transient hiccup.
 */
export async function detectAmphetamineInstalled(
  runOsascriptImpl: RunOsascript = runOsascriptWithRunProcess,
  platform: NodeJS.Platform = process.platform
): Promise<boolean | undefined> {
  if (platform !== 'darwin') {
    return false
  }
  let result: OsascriptResult
  try {
    result = await runOsascriptImpl(AMPHETAMINE_LOCATE_SCRIPT)
  } catch {
    return undefined
  }
  if (result.code === 0) {
    // Empty stdout on success is not a positive miss, so it is unknown too.
    return result.stdout.trim().length > 0 ? true : undefined
  }
  if (result.timedOut) {
    return undefined
  }
  return classifyAmphetamineFailure(result) === 'not-installed' ? false : undefined
}

export function classifyAmphetamineFailure(
  result: OsascriptResult
): AmphetamineUnavailableReason | null {
  const text = `${result.stderr} ${result.stdout}`
  // -1728/-10814: Launch Services cannot resolve the bundle id, i.e. Amphetamine is not installed.
  if (text.includes('-1728') || text.includes('-10814')) {
    return 'not-installed'
  }
  // -1743/errAEEventNotPermitted: the user denied Orca's Automation grant for Amphetamine.
  if (text.includes('-1743') || text.includes('Not authorized to send Apple events')) {
    return 'automation-denied'
  }
  return null
}

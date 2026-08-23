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
 * Trigger-based sessions". So Orca reads the session before writing it and only
 * ever ends a session it started and still recognizes. See
 * docs/reference/macos-keep-awake-engines.md.
 */
/**
 * Check and start in ONE Apple event.
 *
 * Split across two osascript invocations, a user could start a session between
 * the read and the write, and `start new session` would then destroy it. One
 * script closes that window: Amphetamine executes the whole tell block before
 * it handles anything else.
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
 * Verify and end in ONE Apple event.
 *
 * The shape test lives here rather than in TypeScript for the same reason: between
 * a separate read and `end session`, the user could replace the session and Orca
 * would end theirs. "foreign" means the live session is not the one Orca started
 * — timed, Trigger-driven, app/date-based, or blocking display sleep — so it is
 * left alone. Guarded by `is running` so releasing never launches the app.
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

export type RunOsascript = (script: string) => Promise<OsascriptResult>

/** What the acquire script did. */
/**
 * 'orca-shaped' is a session matching what Orca creates but not necessarily one
 * this process started — after a crash it is Orca's own leaked session, which
 * must be reclaimed rather than adopted, or it would never be cleaned up.
 */
export type AmphetamineAcquireOutcome = 'started' | 'orca-shaped' | 'foreign'
/** What the release script did. 'foreign' means the live session is not Orca's. */
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

export function runOsascriptWithRunProcess(script: string): Promise<OsascriptResult> {
  return runProcess({
    program: OSASCRIPT,
    args: ['-e', script],
    timeoutMs: MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS
  })
}

export function runOsascriptSyncWithRunProcess(script: string): OsascriptResult {
  return runProcessSync({
    program: OSASCRIPT,
    args: ['-e', script],
    timeoutMs: MACOS_AMPHETAMINE_QUIT_TIMEOUT_MS
  })
}

/** Resolve the bundle through Launch Services; a non-zero exit means no copy is installed. */
export async function detectAmphetamineInstalled(
  runOsascriptImpl: RunOsascript = runOsascriptWithRunProcess,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (platform !== 'darwin') {
    return false
  }
  try {
    const result = await runOsascriptImpl(AMPHETAMINE_LOCATE_SCRIPT)
    return result.code === 0 && result.stdout.trim().length > 0
  } catch {
    return false
  }
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

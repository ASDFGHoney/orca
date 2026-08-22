import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'
import { runProcess, runProcessSync } from '../shared/child-process/run-process'

export const AMPHETAMINE_BUNDLE_ID = 'com.if.Amphetamine'
export const MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS = 10_000

const OSASCRIPT = '/usr/bin/osascript'

/**
 * Amphetamine's session is a single global one, not a per-process assertion:
 * `start new session` documents that it "ends any existing sessions, including
 * Trigger-based sessions". So Orca reads the session before writing it and only
 * ever ends a session it started and still recognizes. See
 * docs/reference/macos-keep-awake-engines.md.
 */
export const AMPHETAMINE_START_SESSION_SCRIPT =
  `tell application id "${AMPHETAMINE_BUNDLE_ID}" to ` +
  // duration 0 + interval 0 is Amphetamine's documented indefinite session. Omitting
  // options instead inherits the user's default duration, which silently expires.
  'start new session with options {duration:0, interval:0, displaySleepAllowed:true}'

export const AMPHETAMINE_END_SESSION_SCRIPT = `tell application id "${AMPHETAMINE_BUNDLE_ID}" to end session`

/** Guarded by `is running` so a status read never launches Amphetamine as a side effect. */
export const AMPHETAMINE_PROBE_SCRIPT = `if application id "${AMPHETAMINE_BUNDLE_ID}" is running then
	tell application id "${AMPHETAMINE_BUNDLE_ID}"
		if session is active then
			return "active|" & (session time remaining) & "|" & (session is Trigger) & "|" & (display sleep allowed)
		end if
		return "idle|-3|false|false"
	end tell
else
	return "absent|-3|false|false"
end if`

/** Launch Services lookup only — resolving a bundle id sends no Apple event, so it cannot prompt. */
export const AMPHETAMINE_LOCATE_SCRIPT = `POSIX path of (path to application id "${AMPHETAMINE_BUNDLE_ID}")`

export type OsascriptResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type RunOsascript = (script: string) => Promise<OsascriptResult>
export type RunOsascriptSync = (script: string) => OsascriptResult

export type AmphetamineSessionState = {
  /** 'absent' means Amphetamine is not running, which is indistinguishable from having no session. */
  presence: 'active' | 'idle' | 'absent'
  /** Seconds left; 0 = indefinite, -1 = Trigger, -2 = app/date-based, -3 = no session. */
  secondsRemaining: number
  isTrigger: boolean
  displaySleepAllowed: boolean
}

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
    timeoutMs: MACOS_AMPHETAMINE_OSASCRIPT_TIMEOUT_MS
  })
}

export function parseAmphetamineSession(stdout: string): AmphetamineSessionState | null {
  const [presence, remaining, trigger, displaySleep] = stdout.trim().split('|')
  if (presence !== 'active' && presence !== 'idle' && presence !== 'absent') {
    return null
  }
  const secondsRemaining = Number.parseInt(remaining ?? '', 10)
  return {
    presence,
    secondsRemaining: Number.isFinite(secondsRemaining) ? secondsRemaining : -3,
    isTrigger: trigger === 'true',
    displaySleepAllowed: displaySleep === 'true'
  }
}

/**
 * Whether the live session still looks like the one Orca starts.
 *
 * Amphetamine has no session identity, so this is a shape match, not a proof of
 * ownership: indefinite, not Trigger-driven, and display sleep left allowed. A
 * user who replaces Orca's session with an identically shaped one is
 * indistinguishable — the deliberate trade is that every other replacement
 * (timed, Trigger, app/date-based, display-sleep-blocking) is left alone.
 */
export function isOrcaShapedSession(state: AmphetamineSessionState): boolean {
  return (
    state.presence === 'active' &&
    state.secondsRemaining === 0 &&
    !state.isTrigger &&
    state.displaySleepAllowed
  )
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

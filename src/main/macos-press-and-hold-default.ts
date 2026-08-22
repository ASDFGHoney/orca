import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from './codex-accounts/fs-utils'

/**
 * Turns off the macOS accent picker for Orca's own preferences domain (#14746).
 *
 * macOS routes press-and-hold to the accent popup unless an app opts out via
 * `ApplePressAndHoldEnabled`, so holding `j` in vim inserts one character instead of repeating.
 * The key is unset by default, which is why every terminal-hosting Mac app ships this opt-out.
 *
 * Written once and never again: a user who wants the accent picker back sets
 * `defaults write com.stablyai.orca ApplePressAndHoldEnabled -bool true` (or deletes the key), and
 * the recorded decision below keeps a later launch from overwriting that choice.
 *
 * The `macAccentMenuEnabled` setting is the discoverable form of that escape hatch, and outranks
 * both: once the toggle is used Orca writes the value it asks for. It writes only when the choice
 * differs from the one recorded here, so a `defaults write` run *after* the toggle is still the
 * newer choice and survives the next launch. See docs/reference/macos-press-and-hold.md.
 *
 * A fresh write is assumed to land for the *next* launch, not the current one: it goes out through
 * a separate `defaults` process, so this app's own cached copy may not observe it. Whether AppKit
 * re-reads sooner is untested, so the conservative assumption is the one encoded here.
 *
 * If this is ever reverted, delete the key as well — AppKit reads the plist, not this file, so
 * removing the code alone leaves press-and-hold disabled forever for everyone who ran an affected
 * build, with nothing left in the tree to explain it.
 *
 * The `defaults`-binary behaviour this relies on is pinned by the sibling test file, which runs
 * only on a developer Mac: CI has no macOS test runner, so those tests never execute there.
 */

export const PRESS_AND_HOLD_KEY = 'ApplePressAndHoldEnabled'
export const PRESS_AND_HOLD_RECORD_FILE = 'macos-press-and-hold-default.json'
export const PRESS_AND_HOLD_RECORD_VERSION = 1

/** Why not `systemPreferences.getUserDefault`: it reads through the whole NSUserDefaults search
 *  list and is typed non-nullable, so an unset key and an explicit `false` both come back `false` —
 *  and the system default is unset, so it reports `false` on a Mac where press-and-hold is on.
 *  `defaults read <domain> <key>` is domain-scoped and exits 1 when the key is absent. */
const DEFAULTS_BINARY = '/usr/bin/defaults'
const DEFAULTS_TIMEOUT_MS = 5_000
/** Why: `defaults` exits 1 for "does not exist"; other statuses mean the probe itself failed. */
const DEFAULTS_MISSING_STATUS = 1

const ORCA_BUNDLE_ID = 'com.stablyai.orca'

export type PressAndHoldDecision =
  /** Not macOS — nothing is read or written. */
  | 'not-macos'
  /** A previous launch already decided; the domain is never touched again. */
  | 'already-decided'
  /** The running bundle is not Orca's (e.g. a bare `Electron.app`), whose domain we do not own. */
  | 'foreign-bundle'
  /** `defaults read` could not answer, so we cannot tell an unset key from a user's choice. */
  | 'probe-failed'
  /** `defaults write` failed. */
  | 'write-failed'
  /** The domain already carries an explicit value; the user's choice stands. */
  | 'kept-user-preference'
  /** The key was unset and we wrote `false`. */
  | 'applied'
  /** The accent-menu toggle has never been used, so the one-time default above owns the key. */
  | 'no-preference'
  /** The toggle asks for what we last wrote; a hand-run `defaults write` since then stands. */
  | 'setting-already-applied'
  /** We wrote the value the accent-menu toggle asks for. */
  | 'followed-setting'

/** Decisions about the domain itself. Anything else is a condition that can change by next launch. */
const TERMINAL_DECISIONS = new Set<PressAndHoldDecision>([
  'applied',
  'kept-user-preference',
  'followed-setting'
])

export type PressAndHoldRecord = {
  version: number
  decision: PressAndHoldDecision
  domain: string | null
  decidedAt: string
  /** The `macAccentMenuEnabled` value this write was made for, absent until the toggle is used. */
  appliedSetting?: boolean
}

export type PressAndHoldHost = {
  platform: NodeJS.Platform
  resolveBundleIdentifier: () => string | null
  readRecord: () => PressAndHoldRecord | null
  writeRecord: (record: PressAndHoldRecord) => void
  readDomainPreference: (domain: string) => 'set' | 'unset' | 'unknown'
  writeDomainPreference: (domain: string, value: boolean) => boolean
  now: () => string
}

/** Only Orca's own bundle: an unpackaged run is `com.github.Electron`, shared with every other
 *  unpackaged Electron app on the machine. */
export function isOrcaPreferencesDomain(domain: string): boolean {
  return domain === ORCA_BUNDLE_ID || domain.startsWith(`${ORCA_BUNDLE_ID}.`)
}

/** `<bundle>/Contents/MacOS/<exe>` → `<bundle>/Contents/Info.plist`. */
export function readBundleIdentifierFromExecutablePath(execPath: string): string | null {
  try {
    const plist = readFileSync(join(dirname(dirname(execPath)), 'Info.plist'), 'utf8')
    const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)
    const identifier = match?.[1]?.trim()
    return identifier ? identifier : null
  } catch {
    return null
  }
}

/**
 * Why this distinction carries the whole design: only a real "does not exist" answer may be read as
 * unset. A spawn failure or a timeout leaves `status` unset, and calling that unset would let a
 * broken probe overwrite a value the user chose.
 */
export function interpretDefaultsReadFailure(error: unknown): 'unset' | 'unknown' {
  return (error as { status?: number | null }).status === DEFAULTS_MISSING_STATUS
    ? 'unset'
    : 'unknown'
}

export function readDomainPressAndHoldPreference(domain: string): 'set' | 'unset' | 'unknown' {
  try {
    execFileSync(DEFAULTS_BINARY, ['read', domain, PRESS_AND_HOLD_KEY], {
      encoding: 'utf8',
      timeout: DEFAULTS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return 'set'
  } catch (error) {
    return interpretDefaultsReadFailure(error)
  }
}

export function writeDomainPressAndHoldPreference(domain: string, value: boolean): boolean {
  try {
    execFileSync(
      DEFAULTS_BINARY,
      ['write', domain, PRESS_AND_HOLD_KEY, '-bool', value ? 'true' : 'false'],
      { encoding: 'utf8', timeout: DEFAULTS_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'ignore'] }
    )
    return true
  } catch {
    return false
  }
}

export function pressAndHoldRecordPath(userDataPath: string): string {
  return join(userDataPath, PRESS_AND_HOLD_RECORD_FILE)
}

export function parsePressAndHoldRecord(raw: string): PressAndHoldRecord | null {
  const parsed = JSON.parse(raw) as Partial<PressAndHoldRecord>
  if (parsed.version !== PRESS_AND_HOLD_RECORD_VERSION || typeof parsed.decision !== 'string') {
    return null
  }
  return {
    version: PRESS_AND_HOLD_RECORD_VERSION,
    decision: parsed.decision as PressAndHoldDecision,
    domain: typeof parsed.domain === 'string' ? parsed.domain : null,
    decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : '',
    ...(typeof parsed.appliedSetting === 'boolean' ? { appliedSetting: parsed.appliedSetting } : {})
  }
}

/**
 * Apply Orca's press-and-hold default at most once, leaving any explicit user value alone.
 *
 * Returns the decision so startup can log it; the same value is persisted for support triage.
 */
export function ensureMacPressAndHoldDefault(host: PressAndHoldHost): PressAndHoldDecision {
  // Why first and without touching disk: Windows and Linux must do no work at all here.
  if (host.platform !== 'darwin') {
    return 'not-macos'
  }

  const previous = host.readRecord()
  if (previous && TERMINAL_DECISIONS.has(previous.decision)) {
    return 'already-decided'
  }

  const record = (decision: PressAndHoldDecision, domain: string | null): PressAndHoldDecision => {
    // Why skip an unchanged rewrite: the non-terminal decisions are re-evaluated every launch.
    if (!previous || previous.decision !== decision || previous.domain !== domain) {
      host.writeRecord({
        version: PRESS_AND_HOLD_RECORD_VERSION,
        decision,
        domain,
        decidedAt: host.now()
      })
    }
    return decision
  }

  const domain = host.resolveBundleIdentifier()
  if (!domain || !isOrcaPreferencesDomain(domain)) {
    return record('foreign-bundle', domain)
  }

  const existing = host.readDomainPreference(domain)
  if (existing === 'unknown') {
    return record('probe-failed', domain)
  }
  if (existing === 'set') {
    return record('kept-user-preference', domain)
  }
  if (!host.writeDomainPreference(domain, false)) {
    return record('write-failed', domain)
  }
  return record('applied', domain)
}

/**
 * Apply the `macAccentMenuEnabled` toggle, which outranks the one-time default above.
 *
 * `accentMenuEnabled` is `undefined` until the toggle is used; that is what keeps this out of the
 * way of a user who only ever ran `defaults write` by hand.
 */
export function applyMacPressAndHoldPreference(
  host: PressAndHoldHost,
  accentMenuEnabled: boolean | undefined
): PressAndHoldDecision {
  if (host.platform !== 'darwin') {
    return 'not-macos'
  }
  if (accentMenuEnabled === undefined) {
    return 'no-preference'
  }

  const previous = host.readRecord()
  // Why compare against what we last wrote rather than against the domain: a `defaults write` run
  // after the toggle is the newer choice, and re-asserting the toggle every launch would eat it.
  if (previous?.appliedSetting === accentMenuEnabled) {
    return 'setting-already-applied'
  }

  const domain = host.resolveBundleIdentifier()
  if (!domain || !isOrcaPreferencesDomain(domain)) {
    return 'foreign-bundle'
  }
  // `ApplePressAndHoldEnabled` *is* the accent-menu switch, so the toggle maps straight through.
  if (!host.writeDomainPreference(domain, accentMenuEnabled)) {
    return 'write-failed'
  }
  host.writeRecord({
    version: PRESS_AND_HOLD_RECORD_VERSION,
    decision: 'followed-setting',
    domain,
    decidedAt: host.now(),
    appliedSetting: accentMenuEnabled
  })
  return 'followed-setting'
}

/** Why log: silently rewriting a macOS default for the user's login account should leave a trace,
 *  and the failure paths are otherwise invisible. The quiet decisions are the steady state. */
const REPORTED_DECISIONS: Partial<Record<PressAndHoldDecision, string>> = {
  applied: `set ${PRESS_AND_HOLD_KEY}=false so held keys repeat; takes effect next launch`,
  'probe-failed': `could not read ${PRESS_AND_HOLD_KEY}; leaving it alone`,
  'write-failed': `could not write ${PRESS_AND_HOLD_KEY}; held keys will not repeat`,
  'followed-setting': `wrote ${PRESS_AND_HOLD_KEY} for the accent-menu setting; takes effect next launch`
}

function createPressAndHoldHost(userDataPath: string): PressAndHoldHost {
  const recordPath = pressAndHoldRecordPath(userDataPath)
  return {
    platform: process.platform,
    resolveBundleIdentifier: () => readBundleIdentifierFromExecutablePath(process.execPath),
    readRecord: () => {
      try {
        return parsePressAndHoldRecord(readFileSync(recordPath, 'utf8'))
      } catch {
        return null
      }
    },
    writeRecord: (record) => {
      try {
        // Why: this runs before `ready`, and Electron has not necessarily created userData yet.
        mkdirSync(userDataPath, { recursive: true })
        writeFileAtomically(recordPath, `${JSON.stringify(record, null, 2)}\n`)
      } catch {
        // Best-effort: an unwritten record only costs one repeated probe next launch.
      }
    },
    readDomainPreference: readDomainPressAndHoldPreference,
    writeDomainPreference: writeDomainPressAndHoldPreference,
    now: () => new Date().toISOString()
  }
}

function report(decision: PressAndHoldDecision): PressAndHoldDecision {
  const reported = REPORTED_DECISIONS[decision]
  if (reported) {
    console.log(`[press-and-hold] ${reported}`)
  }
  return decision
}

/** Wires {@link ensureMacPressAndHoldDefault} to the real bundle, `defaults`, and userData. */
export function applyMacPressAndHoldDefaultAtStartup(userDataPath: string): PressAndHoldDecision {
  return report(ensureMacPressAndHoldDefault(createPressAndHoldHost(userDataPath)))
}

/** Wires {@link applyMacPressAndHoldPreference}; called once the store loads and on every change. */
export function applyMacPressAndHoldPreferenceFromSettings(
  userDataPath: string,
  accentMenuEnabled: boolean | undefined
): PressAndHoldDecision {
  return report(
    applyMacPressAndHoldPreference(createPressAndHoldHost(userDataPath), accentMenuEnabled)
  )
}

import { describe, expect, it, vi } from 'vitest'
import {
  AMPHETAMINE_ACQUIRE_SCRIPT,
  AMPHETAMINE_RELEASE_SCRIPT,
  classifyAmphetamineFailure,
  detectAmphetamineInstalled,
  parseAcquireOutcome,
  parseReleaseOutcome,
  type OsascriptResult
} from './macos-amphetamine-session'

function ok(stdout = ''): OsascriptResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function failure(stderr: string, code = 1): OsascriptResult {
  return { code, stdout: '', stderr, timedOut: false }
}

describe('Amphetamine scripts', () => {
  it('checks and starts from a single osascript invocation', () => {
    // Not a transaction — AppleScript sends each read and command as its own
    // Apple event — but it removes the process-spawn gap between check and write.
    expect(AMPHETAMINE_ACQUIRE_SCRIPT.match(/tell application id/g)).toHaveLength(1)
    expect(AMPHETAMINE_ACQUIRE_SCRIPT).toContain('if session is active then')
    // The shape test must sit inside the same tell block as the start.
    expect(AMPHETAMINE_ACQUIRE_SCRIPT.indexOf('display sleep allowed')).toBeLessThan(
      AMPHETAMINE_ACQUIRE_SCRIPT.indexOf('start new session')
    )
  })

  it('asks for an indefinite session explicitly', () => {
    // Omitting options inherits the user's default duration, which silently expires.
    expect(AMPHETAMINE_ACQUIRE_SCRIPT).toContain('duration:0')
    expect(AMPHETAMINE_ACQUIRE_SCRIPT).toContain('interval:0')
  })

  it('verifies every foreign-session shape immediately before ending', () => {
    for (const guard of [
      'if not (session is active) then return "gone"',
      'if session is Trigger then return "foreign"',
      'if (session time remaining) is not 0 then return "foreign"',
      'if not (display sleep allowed) then return "foreign"'
    ]) {
      expect(AMPHETAMINE_RELEASE_SCRIPT).toContain(guard)
    }
    // The last shape check must be the Apple event right before the destructive
    // one; that ordering is the smallest window this API allows.
    expect(AMPHETAMINE_RELEASE_SCRIPT.indexOf('display sleep allowed')).toBeLessThan(
      AMPHETAMINE_RELEASE_SCRIPT.indexOf('end session')
    )
  })

  it('never launches Amphetamine just to release', () => {
    expect(AMPHETAMINE_RELEASE_SCRIPT).toContain('is running')
  })
})

describe('outcome parsing', () => {
  it.each([
    ['started', 'started'],
    ['orca-shaped\n', 'orca-shaped'],
    ['foreign', 'foreign']
  ])('parses acquire %s', (stdout, expected) => {
    expect(parseAcquireOutcome(stdout)).toBe(expected)
  })

  it.each([
    ['ended', 'ended'],
    ['foreign\n', 'foreign'],
    ['gone', 'gone']
  ])('parses release %s', (stdout, expected) => {
    expect(parseReleaseOutcome(stdout)).toBe(expected)
  })

  it.each(['', 'what', 'true'])('rejects unrecognized output %s', (stdout) => {
    expect(parseAcquireOutcome(stdout)).toBeNull()
    expect(parseReleaseOutcome(stdout)).toBeNull()
  })
})

describe('detectAmphetamineInstalled', () => {
  it('reports installed when Launch Services resolves the bundle', async () => {
    const run = vi.fn(async (_script: string) => ok('/Applications/Amphetamine.app\n'))
    await expect(detectAmphetamineInstalled(run, 'darwin')).resolves.toBe(true)
  })

  it('reports not installed when the lookup fails', async () => {
    const run = vi.fn(async (_script: string) => failure('execution error: ... (-1728)'))
    await expect(detectAmphetamineInstalled(run, 'darwin')).resolves.toBe(false)
  })

  it('never probes off macOS', async () => {
    const run = vi.fn(async (_script: string) => ok('/Applications/Amphetamine.app'))
    await expect(detectAmphetamineInstalled(run, 'linux')).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('classifyAmphetamineFailure', () => {
  it('reads a missing bundle as not-installed', () => {
    expect(classifyAmphetamineFailure(failure('execution error: (-1728)'))).toBe('not-installed')
  })

  it('reads a refused Apple event as automation-denied', () => {
    expect(
      classifyAmphetamineFailure(failure('Not authorized to send Apple events to Amphetamine.'))
    ).toBe('automation-denied')
  })

  it('leaves transient failures unclassified so they retry', () => {
    expect(classifyAmphetamineFailure(failure('some other problem'))).toBeNull()
  })
})

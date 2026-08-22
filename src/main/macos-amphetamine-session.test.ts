import { describe, expect, it, vi } from 'vitest'
import {
  AMPHETAMINE_PROBE_SCRIPT,
  AMPHETAMINE_START_SESSION_SCRIPT,
  classifyAmphetamineFailure,
  detectAmphetamineInstalled,
  isOrcaShapedSession,
  parseAmphetamineSession,
  type OsascriptResult
} from './macos-amphetamine-session'

function ok(stdout = ''): OsascriptResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function failure(stderr: string, code = 1): OsascriptResult {
  return { code, stdout: '', stderr, timedOut: false }
}

describe('Amphetamine session scripts', () => {
  it('asks for an indefinite session explicitly', () => {
    // Omitting options inherits the user's default duration, which silently expires.
    expect(AMPHETAMINE_START_SESSION_SCRIPT).toContain('duration:0')
    expect(AMPHETAMINE_START_SESSION_SCRIPT).toContain('interval:0')
  })

  it('guards the probe so reading state cannot launch Amphetamine', () => {
    expect(AMPHETAMINE_PROBE_SCRIPT).toContain('is running')
  })
})

describe('parseAmphetamineSession', () => {
  it.each([
    ['active|0|false|true', { presence: 'active', secondsRemaining: 0 }],
    ['active|1199|false|false', { presence: 'active', secondsRemaining: 1199 }],
    ['active|-1|true|false', { presence: 'active', secondsRemaining: -1, isTrigger: true }],
    ['idle|-3|false|false', { presence: 'idle', secondsRemaining: -3 }],
    ['absent|-3|false|false', { presence: 'absent', secondsRemaining: -3 }]
  ])('parses %s', (stdout, expected) => {
    expect(parseAmphetamineSession(stdout)).toMatchObject(expected)
  })

  it('returns null for output it does not recognize', () => {
    expect(parseAmphetamineSession('what')).toBeNull()
    expect(parseAmphetamineSession('')).toBeNull()
  })
})

describe('isOrcaShapedSession', () => {
  const orcaShaped = {
    presence: 'active' as const,
    secondsRemaining: 0,
    isTrigger: false,
    displaySleepAllowed: true
  }

  it('matches the indefinite session Orca starts', () => {
    expect(isOrcaShapedSession(orcaShaped)).toBe(true)
  })

  it.each([
    ['a timed session', { secondsRemaining: 1199 }],
    ['a Trigger session', { secondsRemaining: -1, isTrigger: true }],
    ['an app or date session', { secondsRemaining: -2 }],
    ['a session that blocks display sleep', { displaySleepAllowed: false }],
    ['no session', { presence: 'idle' as const, secondsRemaining: -3 }]
  ])('does not claim %s', (_label, overrides) => {
    expect(isOrcaShapedSession({ ...orcaShaped, ...overrides })).toBe(false)
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

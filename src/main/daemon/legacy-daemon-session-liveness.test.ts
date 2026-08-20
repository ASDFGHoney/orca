import { describe, expect, it } from 'vitest'
import {
  classifyLegacyDaemonSessionActivity,
  decideLegacyDaemonGenerationRetirement
} from './legacy-daemon-session-liveness'

describe('legacy daemon session activity', () => {
  it('treats an attached agent as live regardless of a quiet shell foreground', () => {
    expect(
      classifyLegacyDaemonSessionActivity({
        sessionId: 'pty-agent',
        agentSessionOwners: [{ provider: 'claude' }],
        inspection: { foregroundProcess: 'zsh', hasChildProcesses: false }
      })
    ).toEqual({
      status: 'live',
      sessionId: 'pty-agent',
      reason: 'attached live agent'
    })
  })

  it('treats child processes as live activity', () => {
    expect(
      classifyLegacyDaemonSessionActivity({
        sessionId: 'pty-children',
        inspection: { foregroundProcess: 'zsh', hasChildProcesses: true }
      })
    ).toEqual({
      status: 'live',
      sessionId: 'pty-children',
      reason: 'session has child processes'
    })
  })

  it('treats a non-shell foreground as live activity', () => {
    expect(
      classifyLegacyDaemonSessionActivity({
        sessionId: 'pty-vim',
        inspection: { foregroundProcess: 'vim', hasChildProcesses: false }
      })
    ).toEqual({
      status: 'live',
      sessionId: 'pty-vim',
      reason: 'non-shell foreground process'
    })
  })

  it('classifies a proven idle shell as idle, not by daemon age', () => {
    expect(
      classifyLegacyDaemonSessionActivity({
        sessionId: 'pty-idle',
        agentSessionOwners: [],
        inspection: { foregroundProcess: 'zsh', hasChildProcesses: false }
      })
    ).toMatchObject({ status: 'idle', sessionId: 'pty-idle' })
  })

  it('reports unavailable inspection as unverifiable rather than idle', () => {
    expect(
      classifyLegacyDaemonSessionActivity({
        sessionId: 'pty-unknown',
        inspection: { foregroundProcess: null, hasChildProcesses: true, unavailable: true }
      })
    ).toEqual({
      status: 'unverifiable',
      sessionId: 'pty-unknown',
      reason: 'process inspection unavailable'
    })
  })

  it('reports a failed inspection as unverifiable rather than exited', () => {
    expect(
      classifyLegacyDaemonSessionActivity({
        sessionId: 'pty-failed',
        inspection: { failed: true, reason: 'list timed out' }
      })
    ).toEqual({
      status: 'unverifiable',
      sessionId: 'pty-failed',
      reason: 'list timed out'
    })
  })
})

describe('legacy daemon generation retirement decision', () => {
  it('retires a generation whose sessions are all provably idle, including none', () => {
    expect(decideLegacyDaemonGenerationRetirement([])).toEqual({
      action: 'retire',
      reason: 'all-sessions-idle'
    })
    expect(
      decideLegacyDaemonGenerationRetirement([
        {
          status: 'idle',
          sessionId: 'pty-idle',
          reason: 'no agent, no children, shell or empty foreground'
        }
      ])
    ).toEqual({ action: 'retire', reason: 'all-sessions-idle' })
  })

  it('does not retire a generation hosting recent activity', () => {
    expect(
      decideLegacyDaemonGenerationRetirement([
        { status: 'idle', sessionId: 'pty-idle', reason: 'idle' },
        { status: 'live', sessionId: 'pty-agent', reason: 'attached live agent' }
      ])
    ).toEqual({
      action: 'keep',
      reason: 'live-session',
      liveSessionIds: ['pty-agent']
    })
  })

  it('does not retire a generation whose liveness is unverifiable and reports the leak', () => {
    expect(
      decideLegacyDaemonGenerationRetirement([
        { status: 'idle', sessionId: 'pty-idle', reason: 'idle' },
        { status: 'unverifiable', sessionId: 'pty-gap', reason: 'process inspection unavailable' }
      ])
    ).toEqual({
      action: 'keep',
      reason: 'unverifiable',
      unverifiableSessionIds: ['pty-gap'],
      leak: 'liveness unverifiable for pty-gap'
    })
  })
})

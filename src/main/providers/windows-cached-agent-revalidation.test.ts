import { describe, expect, it } from 'vitest'
import { canRevalidateCachedAgentWithoutScan } from './windows-cached-agent-revalidation'

describe('canRevalidateCachedAgentWithoutScan', () => {
  it('is true for a cached agent when node-pty only names the shell (a scan would run)', () => {
    expect(canRevalidateCachedAgentWithoutScan('claude', 'powershell.exe')).toBe(true)
    expect(canRevalidateCachedAgentWithoutScan('codex', 'cmd.exe')).toBe(true)
  })

  it('is false when node-pty already names a recognized agent (no scan needed)', () => {
    // Nothing to save here — the fast no-scan path already returns the agent.
    expect(canRevalidateCachedAgentWithoutScan('claude', 'claude')).toBe(false)
  })

  it('is false for a generic wrapper that may outlive the cached agent', () => {
    expect(canRevalidateCachedAgentWithoutScan('claude', 'node.exe')).toBe(false)
  })

  it('is false when no agent has been recognized yet (identity must be established first)', () => {
    expect(canRevalidateCachedAgentWithoutScan(null, 'powershell.exe')).toBe(false)
  })

  it('is false when there is no fallback process name', () => {
    expect(canRevalidateCachedAgentWithoutScan('claude', null)).toBe(false)
  })
})

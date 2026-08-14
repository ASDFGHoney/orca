// Why (#11941): the planner is unit-tested next door; this asserts the override
// actually reaches the command string a remote Codex PTY runs, and that the
// local command — the one #8711's env injection already covers — is untouched.

import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { buildAgentStartupPlan } from './tui-agent-startup'

const BASE = {
  cmdOverrides: {},
  platform: 'linux' as NodeJS.Platform,
  shell: 'posix' as const
}

describe('resolveAgentLaunchCommand — remote Codex hooks override', () => {
  it('adds the launch-scoped hooks override for a remote Codex launch', () => {
    const result = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'codex',
      isRemote: true,
      agentStatusHooksEnabled: true
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.command).toContain("'-c' 'features.hooks=true'")
  })

  it('keeps the local Codex command byte-for-byte unchanged', () => {
    const local = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'codex',
      isRemote: false,
      agentStatusHooksEnabled: true
    })
    const baseline = resolveAgentLaunchCommand({ ...BASE, agent: 'codex', isRemote: false })
    expect(local.ok && baseline.ok && local.command).toBe(baseline.ok ? baseline.command : null)
    expect(local.ok && local.command).not.toContain('features.hooks')
  })

  it('keeps remote Claude unchanged', () => {
    const result = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'claude',
      isRemote: true,
      agentStatusHooksEnabled: true
    })
    expect(result.ok && result.command).not.toContain('features.hooks')
  })

  it('emits nothing when the user already disabled hooks in their CLI args', () => {
    const result = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'codex',
      isRemote: true,
      agentStatusHooksEnabled: true,
      agentArgs: '--disable hooks'
    })
    expect(result.ok && result.command).not.toContain('features.hooks=true')
  })

  it('emits nothing when a command override already decides hooks', () => {
    const result = resolveAgentLaunchCommand({
      ...BASE,
      agent: 'codex',
      cmdOverrides: { codex: 'codex -c features.hooks=false' },
      isRemote: true,
      agentStatusHooksEnabled: true
    })
    expect(result.ok && result.command).not.toContain('features.hooks=true')
  })

  it('keeps the override ahead of the prompt on the argv launch path', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'do the thing',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: true,
      agentStatusHooksEnabled: true
    })
    expect(plan).not.toBeNull()
    const command = plan?.launchCommand ?? ''
    expect(command).toContain("'-c' 'features.hooks=true'")
    expect(command.indexOf('features.hooks=true')).toBeLessThan(command.indexOf('do the thing'))
  })

  it('omits the override for a remote Codex launch when hooks are disabled', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'do the thing',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      isRemote: true,
      agentStatusHooksEnabled: false
    })
    expect(plan?.launchCommand).not.toContain('features.hooks')
  })
})

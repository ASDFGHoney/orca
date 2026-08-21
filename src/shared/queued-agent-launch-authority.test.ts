import { describe, expect, it } from 'vitest'
import { attachQueuedAgentLaunchAuthority } from './queued-agent-launch-authority'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('attachQueuedAgentLaunchAuthority', () => {
  it('stamps a bare cursor-agent command with launch config and a launch token', () => {
    const stamped = attachQueuedAgentLaunchAuthority({ command: 'cursor-agent' })
    expect(stamped.launchAgent).toBe('cursor')
    expect(stamped.launchConfig).toEqual({
      agentCommand: 'cursor-agent',
      agentArgs: '',
      agentEnv: {}
    })
    expect(stamped.launchToken).toMatch(UUID_RE)
    expect(stamped.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe(stamped.launchToken)
  })

  it('leaves a plain shell command tokenless', () => {
    expect(attachQueuedAgentLaunchAuthority({ command: 'echo hi' })).toEqual({ command: 'echo hi' })
  })

  it('does not mint authority for a non-bare agent invocation', () => {
    expect(attachQueuedAgentLaunchAuthority({ command: 'codex exec summarize' })).toEqual({
      command: 'codex exec summarize'
    })
  })

  it('reuses an explicit launch token instead of minting another', () => {
    const stamped = attachQueuedAgentLaunchAuthority({
      command: 'cursor-agent',
      launchToken: 'explicit-token'
    })
    expect(stamped.launchToken).toBe('explicit-token')
    expect(stamped.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe('explicit-token')
  })
})

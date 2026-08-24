import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan, buildAgentStartupPlan } from './tui-agent-startup'
import { hasCompleteRemoteAgentHookContext } from './codex-remote-hook-launch'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function launch(command: string) {
  return buildAgentStartupPlan({
    agent: 'codex',
    prompt: 'fix it',
    cmdOverrides: { codex: command },
    platform: 'linux',
    shell: 'posix',
    isRemote: true
  })
}

describe('remote Codex hook launch context', () => {
  it('requires matching valid pane metadata and final server coordinates', () => {
    const env = {
      ORCA_AGENT_HOOK_PORT: '43117',
      ORCA_AGENT_HOOK_TOKEN: 'token-1',
      ORCA_PANE_KEY: PANE_KEY
    }

    expect(hasCompleteRemoteAgentHookContext({ env, paneKey: PANE_KEY })).toBe(true)
    expect(hasCompleteRemoteAgentHookContext({ env, paneKey: undefined })).toBe(false)
    expect(hasCompleteRemoteAgentHookContext({ env, paneKey: 'other:1' })).toBe(false)
    expect(
      hasCompleteRemoteAgentHookContext({
        env: { ...env, ORCA_AGENT_HOOK_TOKEN: '' },
        paneKey: PANE_KEY
      })
    ).toBe(false)
  })

  it('preserves the shell command word and marks direct remote POSIX launches', () => {
    const plan = launch("CODEX_HOME='/tmp/codex home' codex --profile captured")

    expect(plan?.launchCommand).toBe(
      "CODEX_HOME='/tmp/codex home' codex --profile captured 'fix it'"
    )
    expect(plan?.startupCommandDelivery).toBe('shell-ready')
    expect(plan?.env).toBeUndefined()
  })

  it('preserves shell-ready delivery on captured resume commands', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      agentCommand: 'codex --profile captured',
      platform: 'linux',
      shell: 'posix',
      isRemote: true
    })

    expect(plan?.launchCommand).toBe("codex --profile captured 'resume' 's1'")
    expect(plan?.startupCommandDelivery).toBe('shell-ready')
    expect(plan?.env).toBeUndefined()
  })

  it.each([
    ["'CODEX_HOME=/tmp/codex' codex", "'CODEX_HOME=/tmp/codex' codex 'fix it'"],
    ['select-profile && codex', "select-profile && codex 'fix it'"],
    ['FOO=bar; codex', "FOO=bar; codex 'fix it'"],
    ['codex && echo done', "codex && echo done 'fix it'"],
    ['codex\necho done', "codex\necho done 'fix it'"],
    ['sh -c \'codex "$@"\' --', "sh -c 'codex \"$@\"' -- 'fix it'"],
    ['npx @openai/codex', "npx @openai/codex 'fix it'"],
    ['mise exec -- codex', "mise exec -- codex 'fix it'"],
    ['/opt/codex/bin/codex', "/opt/codex/bin/codex 'fix it'"]
  ])('fails open for an opaque Codex command: %s', (command, expected) => {
    const plan = launch(command)
    expect(plan?.launchCommand).toBe(expected)
    expect(plan?.env).toBeUndefined()
  })

  it.each([
    { agent: 'claude' as const, platform: 'linux' as const, isRemote: true },
    { agent: 'codex' as const, platform: 'linux' as const, isRemote: false },
    { agent: 'codex' as const, platform: 'win32' as const, isRemote: true }
  ])('leaves non-target launch context unchanged: $agent/$platform/$isRemote', (context) => {
    const plan = buildAgentStartupPlan({
      ...context,
      prompt: 'fix it',
      cmdOverrides: {},
      shell: context.platform === 'win32' ? 'powershell' : 'posix'
    })

    expect(plan?.env).toBeUndefined()
  })
})

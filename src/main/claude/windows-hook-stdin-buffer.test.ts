import { describe, expect, it } from 'vitest'
import {
  MANAGED_HOOK_TIMEOUT_SECONDS,
  buildWindowsAgentHookCurlPostCommand
} from '../agent-hooks/installer-utils'
import { buildWindowsHookStdinDrainEpilogue } from '../agent-hooks/hook-stdin-contract'
import {
  CLAUDE_EVENTS,
  CLAUDE_HOOK_SETTINGS,
  OPENCLAUDE_HOOK_SETTINGS,
  applyManagedHooks,
  getManagedLifecycleHook
} from './hook-settings'
import {
  WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV,
  WINDOWS_CLAUDE_HOOK_STDIN_IDLE_TIMEOUT_MILLISECONDS,
  WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES,
  buildWindowsClaudeHookStdinBuffer
} from './windows-hook-stdin-buffer'

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  return Buffer.from(encoded ?? '', 'base64').toString('utf16le')
}

describe('Windows Claude hook stdin buffer', () => {
  it('bounds the reader before launching children and makes the payload file crash-cleanup-safe', () => {
    const command = buildWindowsClaudeHookStdinBuffer('& $scriptPath')

    expect(command).toContain('$inputStream.ReadAsync')
    expect(command).toContain(`$read.Wait(${WINDOWS_CLAUDE_HOOK_STDIN_IDLE_TIMEOUT_MILLISECONDS})`)
    expect(command).toContain(`$payload.Length -lt ${WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES}`)
    expect(command).toContain('[System.IO.FileOptions]::DeleteOnClose')
    expect(command).toContain(`$env:${WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV} = $payloadPath`)
    expect(command.indexOf('$inputStream.ReadAsync')).toBeLessThan(command.indexOf('& $scriptPath'))
  })

  it('generates the bounded launcher only for local Windows Claude settings', () => {
    const windowsClaude = getManagedLifecycleHook(
      'C:\\Users\\test\\.orca\\agent-hooks\\claude-hook.cmd',
      CLAUDE_HOOK_SETTINGS,
      'win32'
    )
    const windowsOpenClaude = getManagedLifecycleHook(
      'openclaude-hook.cmd',
      OPENCLAUDE_HOOK_SETTINGS,
      'win32'
    )
    const posixClaude = getManagedLifecycleHook(
      '/home/test/.orca/agent-hooks/claude-hook.sh',
      CLAUDE_HOOK_SETTINGS,
      'linux'
    )

    expect(decodePowerShellCommand(windowsClaude.command)).toContain('$inputStream.ReadAsync')
    expect(windowsClaude.timeout).toBe(MANAGED_HOOK_TIMEOUT_SECONDS)
    expect(decodePowerShellCommand(windowsOpenClaude.command)).toBe('')
    expect(windowsOpenClaude.timeout).toBe(MANAGED_HOOK_TIMEOUT_SECONDS)
    expect(decodePowerShellCommand(posixClaude.command)).toBe('')
    expect(posixClaude.timeout).toBe(MANAGED_HOOK_TIMEOUT_SECONDS)

    const generated = applyManagedHooks({}, windowsClaude)
    expect(Object.keys(generated.hooks ?? {})).toHaveLength(CLAUDE_EVENTS.length)
    for (const event of CLAUDE_EVENTS) {
      expect(generated.hooks?.[event.eventName]?.[0]?.hooks).toEqual([windowsClaude])
    }
  })

  it('feeds curl and the drain from the closed payload file while preserving generic stdin readers', () => {
    const claudeCurl = buildWindowsAgentHookCurlPostCommand(
      'claude',
      WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV
    )
    expect(claudeCurl).toContain(
      `--data-urlencode "payload@%${WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV}%"`
    )
    expect(buildWindowsAgentHookCurlPostCommand('codex')).toContain('--data-urlencode "payload@-"')

    const claudeDrain = buildWindowsHookStdinDrainEpilogue(
      WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV
    ).join('\r\n')
    expect(claudeDrain).toContain(`< "%${WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV}%" >nul 2>nul`)
    expect(buildWindowsHookStdinDrainEpilogue().join('\r\n')).toContain('more.com" >nul 2>nul')
  })
})

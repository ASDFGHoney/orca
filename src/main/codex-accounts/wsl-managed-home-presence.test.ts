import { describe, expect, it } from 'vitest'
import {
  buildWslManagedHomeCreateArgs,
  buildWslManagedHomePresenceArgs,
  classifyWslManagedHomeExecError,
  WSL_MANAGED_HOME_ABSENT_STATUS,
  WSL_MANAGED_HOME_UNREADABLE_STATUS
} from './wsl-managed-home-presence'

function decodeEncodedWslBashCommand(command: string): string {
  const encoded = command.match(/^set -o pipefail; printf %s '([^']+)' \| base64 -d \| bash$/)?.[1]
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : command
}

describe('WSL managed home presence probes', () => {
  it('probes with --exec and never mkdir/rewrites the marker', () => {
    const args = buildWslManagedHomePresenceArgs(
      'Ubuntu',
      '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    )
    const script = decodeEncodedWslBashCommand(String(args.at(-1)))
    expect(args.slice(0, 3)).toEqual(['-d', 'Ubuntu', '--exec'])
    expect(script).toContain('stat --')
    expect(script).not.toContain('mkdir')
    expect(script).not.toContain('.orca-managed-home')
  })

  it('creates the home only in the post-absence write argv', () => {
    const args = buildWslManagedHomeCreateArgs(
      'Ubuntu',
      '/home/alice/.local/share/orca/codex-accounts/account-1/home',
      'account-1'
    )
    const script = decodeEncodedWslBashCommand(String(args.at(-1)))
    expect(args.slice(0, 3)).toEqual(['-d', 'Ubuntu', '--exec'])
    expect(script).toContain('mkdir -p --')
    expect(script).toContain('.orca-managed-home')
    expect(script).not.toContain('[ -e ')
    expect(script).not.toContain('[ -f ')
  })

  it('treats only exit 2 as absence; every other failure is unreadable', () => {
    expect(classifyWslManagedHomeExecError({ status: WSL_MANAGED_HOME_ABSENT_STATUS })).toBe(
      'absent'
    )
    expect(classifyWslManagedHomeExecError({ status: WSL_MANAGED_HOME_UNREADABLE_STATUS })).toBe(
      'unreadable'
    )
    expect(classifyWslManagedHomeExecError({ status: 1 })).toBe('unreadable')
    expect(classifyWslManagedHomeExecError({ code: 'ENOENT' })).toBe('unreadable')
    expect(classifyWslManagedHomeExecError(new Error('spawn wsl.exe ENOENT'))).toBe('unreadable')
  })
})

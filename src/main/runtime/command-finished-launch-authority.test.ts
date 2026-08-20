import { describe, expect, it } from 'vitest'

import { shouldRetireLaunchAuthorityOnCommandFinished } from './command-finished-launch-authority'

describe('shouldRetireLaunchAuthorityOnCommandFinished', () => {
  it('does not retire while a recognized agent is still foreground', () => {
    expect(shouldRetireLaunchAuthorityOnCommandFinished('omp')).toBe(false)
    expect(shouldRetireLaunchAuthorityOnCommandFinished('omp.exe')).toBe(false)
    expect(shouldRetireLaunchAuthorityOnCommandFinished('/usr/local/bin/omp')).toBe(false)
    expect(shouldRetireLaunchAuthorityOnCommandFinished('pi')).toBe(false)
    expect(shouldRetireLaunchAuthorityOnCommandFinished('codex')).toBe(false)
  })

  it('retires only when the execution host shows a shell in the foreground', () => {
    expect(shouldRetireLaunchAuthorityOnCommandFinished('zsh')).toBe(true)
    expect(shouldRetireLaunchAuthorityOnCommandFinished('bash')).toBe(true)
    expect(shouldRetireLaunchAuthorityOnCommandFinished('powershell.exe')).toBe(true)
    expect(shouldRetireLaunchAuthorityOnCommandFinished('pwsh')).toBe(true)
  })

  it('treats a missing foreground read as unverifiable, not exited', () => {
    expect(shouldRetireLaunchAuthorityOnCommandFinished(null)).toBe(false)
    expect(shouldRetireLaunchAuthorityOnCommandFinished('')).toBe(false)
  })

  it('does not treat an unknown non-shell process as agent exit', () => {
    expect(shouldRetireLaunchAuthorityOnCommandFinished('node')).toBe(false)
    expect(shouldRetireLaunchAuthorityOnCommandFinished('python3')).toBe(false)
  })
})

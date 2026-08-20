import { describe, expect, it } from 'vitest'
import {
  isWslAliasedPathInsideOrEqual,
  normalizedWslPathAliases,
  wslPathAliases
} from './wsl-path-aliases'

describe('wslPathAliases', () => {
  it('pairs a Windows drive path with its WSL drvfs mount', () => {
    expect(wslPathAliases(String.raw`C:\Users\neil\orca\orca`)).toEqual([
      String.raw`C:\Users\neil\orca\orca`,
      '/mnt/c/Users/neil/orca/orca'
    ])
  })

  it('pairs a WSL drvfs mount with its Windows drive path', () => {
    expect(wslPathAliases('/mnt/c/Users/neil/orca/orca')).toEqual([
      '/mnt/c/Users/neil/orca/orca',
      String.raw`C:\Users\neil\orca\orca`
    ])
  })

  it('keeps distro-native UNC aliases and unfolds a UNC-mounted drive', () => {
    expect(wslPathAliases(String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`)).toEqual([
      String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`,
      '/home/ada/repo'
    ])
    expect(wslPathAliases(String.raw`\\wsl.localhost\Ubuntu\mnt\c\Users\neil\orca`)).toEqual([
      String.raw`\\wsl.localhost\Ubuntu\mnt\c\Users\neil\orca`,
      '/mnt/c/Users/neil/orca',
      String.raw`C:\Users\neil\orca`
    ])
  })

  it('does not invent aliases for an ordinary POSIX path', () => {
    expect(wslPathAliases('/home/ada/repo')).toEqual(['/home/ada/repo'])
  })
})

describe('isWslAliasedPathInsideOrEqual', () => {
  it('treats C:\\ and /mnt/c as the same workspace, including case-folded drives', () => {
    expect(
      isWslAliasedPathInsideOrEqual(
        String.raw`C:\Users\neil\orca\orca`,
        '/mnt/c/Users/neil/orca/orca'
      )
    ).toBe(true)
    expect(
      isWslAliasedPathInsideOrEqual(
        String.raw`c:\users\neil\orca\orca`,
        '/mnt/c/Users/neil/orca/orca/src'
      )
    ).toBe(true)
  })

  it('rejects a sibling path that only shares a prefix', () => {
    expect(
      isWslAliasedPathInsideOrEqual(String.raw`C:\Users\neil\orca`, '/mnt/c/Users/neil/orca-secret')
    ).toBe(false)
  })

  it('still matches a WSL UNC worktree against a Linux cwd', () => {
    expect(
      isWslAliasedPathInsideOrEqual(
        String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`,
        '/home/ada/repo/app'
      )
    ).toBe(true)
  })
})

describe('normalizedWslPathAliases', () => {
  it('folds the Windows drive spelling so /mnt/c can match a case-variant workspace', () => {
    expect(normalizedWslPathAliases('/mnt/c/Users/neil/orca/orca')).toEqual([
      '/mnt/c/Users/neil/orca/orca',
      'c:/users/neil/orca/orca'
    ])
  })
})

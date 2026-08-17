import { describe, expect, it } from 'vitest'
import type { RetiredNameRegistry } from '../shared/worktree/retired-name-registry'
import {
  MAX_RETIREMENT_NAMESPACES,
  migrateRetirementNamespaceHostIdentity,
  recordRetirementNamespaceRegistry,
  retirementHostIdentity,
  retirementNamespaceKey,
  UNKNOWN_SSH_HOST_IDENTITY
} from './worktree-retirement-namespace'

function registry(...names: string[]): RetiredNameRegistry {
  return { exhaustedTiers: 0, names }
}

const TARGET = {
  configHost: 'builder',
  host: 'builder.example.com',
  port: 22,
  username: 'dev'
}

describe('recordRetirementNamespaceRegistry', () => {
  it('evicts the least recently recorded namespace once the map is full', () => {
    const namespaces: Record<string, RetiredNameRegistry> = {}
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES; index += 1) {
      recordRetirementNamespaceRegistry(namespaces, `local:posix:/w/${index}`, registry('nautilus'))
    }

    recordRetirementNamespaceRegistry(namespaces, 'local:posix:/w/new', registry('seahorse'))

    expect(Object.keys(namespaces)).toHaveLength(MAX_RETIREMENT_NAMESPACES)
    expect(namespaces['local:posix:/w/0']).toBeUndefined()
    expect(namespaces['local:posix:/w/1']).toEqual(registry('nautilus'))
    expect(namespaces['local:posix:/w/new']).toEqual(registry('seahorse'))
  })

  it('refreshes a namespace it rewrites so an actively used repo is never the eviction victim', () => {
    const namespaces: Record<string, RetiredNameRegistry> = {}
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES; index += 1) {
      recordRetirementNamespaceRegistry(namespaces, `local:posix:/w/${index}`, registry('nautilus'))
    }

    // The oldest key retires a second name, then a brand new namespace forces one eviction.
    recordRetirementNamespaceRegistry(namespaces, 'local:posix:/w/0', registry('nautilus', 'orca'))
    recordRetirementNamespaceRegistry(namespaces, 'local:posix:/w/new', registry('seahorse'))

    expect(namespaces['local:posix:/w/0']).toEqual(registry('nautilus', 'orca'))
    expect(namespaces['local:posix:/w/1']).toBeUndefined()
  })

  it('stays at one entry per namespace no matter how often it is rewritten', () => {
    const namespaces: Record<string, RetiredNameRegistry> = {}
    for (let index = 0; index < MAX_RETIREMENT_NAMESPACES * 2; index += 1) {
      recordRetirementNamespaceRegistry(namespaces, 'local:posix:/w/a', registry(`name-${index}`))
    }

    expect(Object.keys(namespaces)).toEqual(['local:posix:/w/a'])
  })
})

describe('migrateRetirementNamespaceHostIdentity', () => {
  it('folds a migrated namespace into one the new identity already owns', () => {
    const namespaces = {
      'ssh:old-id:posix:/srv/a': registry('nautilus'),
      'ssh:new|22|dev:posix:/srv/a': registry('seahorse')
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        moveFrom: ['ssh:old-id'],
        to: 'ssh:new|22|dev'
      })
    ).toBe(true)
    expect(Object.keys(namespaces)).toEqual(['ssh:new|22|dev:posix:/srv/a'])
    expect(namespaces['ssh:new|22|dev:posix:/srv/a'].names.toSorted()).toEqual([
      'nautilus',
      'seahorse'
    ])
  })

  it('keeps the source bucket when an endpoint identity moves, since a live target may share it', () => {
    // A second target can still resolve to `old|22|dev`. Stripping its tombstones would reissue a
    // path whose agent history is still on disk — the one outcome retirement exists to prevent.
    const namespaces = {
      'ssh:old|22|dev:posix:/srv/a': registry('nautilus')
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        copyFrom: ['ssh:old|22|dev'],
        to: 'ssh:new|22|dev'
      })
    ).toBe(true)
    expect(Object.keys(namespaces).toSorted()).toEqual([
      'ssh:new|22|dev:posix:/srv/a',
      'ssh:old|22|dev:posix:/srv/a'
    ])
    expect(namespaces['ssh:old|22|dev:posix:/srv/a'].names).toEqual(['nautilus'])
    expect(namespaces['ssh:new|22|dev:posix:/srv/a'].names).toEqual(['nautilus'])
  })

  it('reports no change when a repeated copy adds nothing the destination lacks', () => {
    // Re-import runs this on every add; a no-op copy must not schedule a save.
    const namespaces = {
      'ssh:old|22|dev:posix:/srv/a': registry('nautilus'),
      'ssh:new|22|dev:posix:/srv/a': registry('nautilus')
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        copyFrom: ['ssh:old|22|dev'],
        to: 'ssh:new|22|dev'
      })
    ).toBe(false)
  })

  it('leaves an identity that merely shares a prefix with the old one alone', () => {
    // `dev` must not swallow `dev2`: the separator is part of the prefix, not an afterthought.
    const namespaces = {
      'ssh:h|22|dev2:posix:/srv/a': registry('nautilus')
    }

    expect(
      migrateRetirementNamespaceHostIdentity(namespaces, {
        moveFrom: ['ssh:h|22|dev'],
        to: 'ssh:h|22|other'
      })
    ).toBe(false)
    expect(Object.keys(namespaces)).toEqual(['ssh:h|22|dev2:posix:/srv/a'])
  })

  it('reports no change when there is nothing to move or the identity is unchanged', () => {
    expect(
      migrateRetirementNamespaceHostIdentity(undefined, { moveFrom: ['ssh:a'], to: 'ssh:b' })
    ).toBe(false)
    expect(
      migrateRetirementNamespaceHostIdentity(
        { 'ssh:a:posix:/srv': registry('nautilus') },
        { to: 'ssh:a' }
      )
    ).toBe(false)
    expect(
      migrateRetirementNamespaceHostIdentity(
        { 'ssh:a:posix:/srv': registry('nautilus') },
        { moveFrom: ['ssh:a'], to: 'ssh:a' }
      )
    ).toBe(false)
  })
})

describe('retirementHostIdentity', () => {
  it('resolves an SSH repo to the endpoint its target reaches, not the target row id', () => {
    const identity = retirementHostIdentity({ connectionId: 'ssh-1' }, () => TARGET)

    expect(identity).toBe('ssh:builder.example.com|22|dev')
    expect(retirementHostIdentity({ connectionId: 'ssh-2' }, () => TARGET)).toBe(identity)
  })

  it('falls back to one shared bucket when the target row is gone', () => {
    expect(retirementHostIdentity({ connectionId: 'ssh-1' }, () => undefined)).toBe(
      UNKNOWN_SSH_HOST_IDENTITY
    )
    expect(retirementHostIdentity({ connectionId: 'ssh-1' })).toBe(UNKNOWN_SSH_HOST_IDENTITY)
  })

  it('leaves a non-SSH repo on its execution host id', () => {
    expect(retirementHostIdentity({})).toBe('local')
  })
})

describe('retirementNamespaceKey', () => {
  it('keeps Windows paths case- and separator-insensitive without colliding with a POSIX path', () => {
    expect(retirementNamespaceKey('local', 'C:\\Workspaces\\Probe')).toBe(
      retirementNamespaceKey('local', 'C:/workspaces/probe')
    )
    expect(retirementNamespaceKey('local', 'C:\\workspaces\\probe')).not.toBe(
      retirementNamespaceKey('local', '/workspaces/probe')
    )
  })

  it('keeps POSIX paths case-sensitive, matching the filesystems they name', () => {
    expect(retirementNamespaceKey('local', '/srv/Probe')).not.toBe(
      retirementNamespaceKey('local', '/srv/probe')
    )
  })
})

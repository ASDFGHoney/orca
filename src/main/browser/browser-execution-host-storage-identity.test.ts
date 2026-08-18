import { describe, expect, it } from 'vitest'
import { browserNetworkExecutionHostStorageIdentity } from './browser-execution-host-storage-identity'
import { browserNetworkExecutionHostKey } from './browser-network-execution-route'

describe('browserNetworkExecutionHostStorageIdentity', () => {
  it('ignores the per-boot components the route key fences on', () => {
    expect(
      browserNetworkExecutionHostStorageIdentity({
        kind: 'native',
        runtimeId: 'runtime-a',
        revision: 1
      })
    ).toBe(
      browserNetworkExecutionHostStorageIdentity({
        kind: 'native',
        runtimeId: 'runtime-a',
        revision: 2
      })
    )
    expect(
      browserNetworkExecutionHostStorageIdentity({
        kind: 'wsl',
        runtimeId: 'runtime-a',
        revision: 1,
        distro: 'Ubuntu'
      })
    ).toBe(
      browserNetworkExecutionHostStorageIdentity({
        kind: 'wsl',
        runtimeId: 'runtime-a',
        revision: 2,
        distro: 'Ubuntu'
      })
    )
    expect(
      browserNetworkExecutionHostStorageIdentity({
        kind: 'ssh',
        targetId: 'ssh-1',
        providerEpoch: 'epoch-a',
        connectionGeneration: 1
      })
    ).toBe(
      browserNetworkExecutionHostStorageIdentity({
        kind: 'ssh',
        targetId: 'ssh-1',
        providerEpoch: 'epoch-b',
        connectionGeneration: 2
      })
    )
  })

  it('separates every boundary that changes storage or egress', () => {
    const identities = [
      browserNetworkExecutionHostStorageIdentity({
        kind: 'native',
        runtimeId: 'runtime-a',
        revision: 1
      }),
      browserNetworkExecutionHostStorageIdentity({
        kind: 'native',
        runtimeId: 'runtime-b',
        revision: 1
      }),
      browserNetworkExecutionHostStorageIdentity({
        kind: 'wsl',
        runtimeId: 'runtime-a',
        revision: 1,
        distro: 'Ubuntu'
      }),
      browserNetworkExecutionHostStorageIdentity({
        kind: 'wsl',
        runtimeId: 'runtime-a',
        revision: 1,
        distro: 'Debian'
      }),
      browserNetworkExecutionHostStorageIdentity({
        kind: 'ssh',
        targetId: 'ssh-1',
        providerEpoch: 'epoch-a',
        connectionGeneration: 1
      }),
      browserNetworkExecutionHostStorageIdentity({
        kind: 'ssh',
        targetId: 'ssh-2',
        providerEpoch: 'epoch-a',
        connectionGeneration: 1
      })
    ]

    expect(new Set(identities).size).toBe(identities.length)
  })

  it('keeps delimiter-bearing components structurally distinct', () => {
    expect(
      browserNetworkExecutionHostStorageIdentity({
        kind: 'wsl',
        runtimeId: 'a',
        revision: 1,
        distro: 'b","c'
      })
    ).not.toBe(
      browserNetworkExecutionHostStorageIdentity({
        kind: 'wsl',
        runtimeId: 'a","b',
        revision: 1,
        distro: 'c'
      })
    )
  })

  it('is never mistaken for a route fencing key', () => {
    const host = {
      kind: 'native',
      runtimeId: 'runtime-a',
      revision: 7
    } as const

    expect(browserNetworkExecutionHostStorageIdentity(host)).not.toBe(
      browserNetworkExecutionHostKey(host)
    )
  })
})

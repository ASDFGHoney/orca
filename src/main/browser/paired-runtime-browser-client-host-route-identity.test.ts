import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))

type CompositionOptions = { onError(error: Error): void }
const compositions: { options: CompositionOptions; closed: Error[] }[] = []

vi.mock('./paired-runtime-browser-client-host-composition', () => ({
  PairedRuntimeBrowserClientHostComposition: class {
    private readonly record: { options: CompositionOptions; closed: Error[] }

    constructor(options: CompositionOptions) {
      this.record = { options, closed: [] }
      compositions.push(this.record)
    }

    start(): Promise<unknown> {
      return Promise.resolve({ authority: 'lease-a' })
    }

    close(error?: Error): Promise<boolean> {
      if (error) {
        this.record.closed.push(error)
      }
      return Promise.resolve(true)
    }

    whenClosed(): Promise<void> {
      return Promise.resolve()
    }
  }
}))

import {
  configurePairedRuntimeBrowserClientHostsForOrcaProfile,
  getPairedRuntimeBrowserClientRouteIdentity,
  startPairedRuntimeBrowserClientHost
} from './paired-runtime-browser-client-host-runtime'

function pairedEnvironment(id: string): KnownRuntimeEnvironment {
  return {
    id,
    name: `Environment ${id}`,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        endpoint: 'ws://127.0.0.1:9999',
        deviceToken: 'token-a',
        publicKeyB64: 'key-a'
      }
    ]
  } as KnownRuntimeEnvironment
}

beforeEach(() => {
  compositions.length = 0
})

describe('client host route identity lifetime', () => {
  it('stops answering with a route identity once the host is retired by its own error', async () => {
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
    const environment = pairedEnvironment('environment-retired')
    await startPairedRuntimeBrowserClientHost({
      environment,
      authorityRuntimeId: 'runtime-a'
    })
    expect(getPairedRuntimeBrowserClientRouteIdentity(environment.id)).not.toBeNull()

    const failure = new Error('lease fenced')
    compositions.at(-1)?.options.onError(failure)
    await vi.waitFor(() => {
      expect(compositions.at(-1)?.closed).toEqual([failure])
    })

    // Why: a cookie import must fall through to the server RPC, not target the dead partition.
    expect(getPairedRuntimeBrowserClientRouteIdentity(environment.id)).toBeNull()
  })
})

import { afterEach, describe, expect, it } from 'vitest'

import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import {
  BrowserClientDownloadRelay,
  type BrowserClientDownloadRoute
} from './browser-client-download-relay'
import { resetBrowserClientDownloadRouting } from './browser-client-download-routing'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'

const page: BrowserClientHostedPageInventory = Object.freeze({
  authorityRuntimeId: 'runtime-1',
  authorityEpoch: 'epoch-1',
  browserHostClientId: 'host-1',
  browserHostGeneration: 2,
  browserPageId: 'page-1',
  pageHostGeneration: 3,
  browserProfileId: 'profile-1',
  executionHostKey: 'host-key',
  state: 'active'
})

function negotiatedTransport(
  handler: (method: string, params: unknown) => unknown
): BrowserClientFileChannelTransport {
  const transport = new BrowserClientFileChannelTransport()
  transport.bind({
    fileChannelNegotiated: true,
    fileChannelAvailability: 'negotiated',
    sendFileChannelRequest: async (method, params) =>
      ({ ok: true, result: handler(method, params), _meta: {} }) as never
  })
  return transport
}

function boundTransport(
  availability: 'unsupported' | 'unavailable'
): BrowserClientFileChannelTransport {
  const transport = new BrowserClientFileChannelTransport()
  transport.bind({
    fileChannelNegotiated: false,
    fileChannelAvailability: availability,
    sendFileChannelRequest: async () => ({ ok: true, result: {}, _meta: {} }) as never
  })
  return transport
}

function remoteRoute(outcome: ReturnType<BrowserClientDownloadRelay['route']>) {
  expect(outcome.kind).toBe('remote')
  return (outcome as { kind: 'remote'; route: BrowserClientDownloadRoute }).route
}

function memoryFilesystem(contents: Buffer) {
  const removed: string[] = []
  const created: string[] = []
  return {
    removed,
    created,
    filesystem: {
      mkdirSync: (directory: string) => {
        created.push(directory)
      },
      readChunks: async function* (_filePath: string, chunkBytes: number) {
        for (let offset = 0; offset < contents.byteLength; offset += chunkBytes) {
          yield contents.subarray(offset, offset + chunkBytes)
        }
      },
      size: async () => contents.byteLength,
      remove: async (filePath: string) => {
        removed.push(filePath)
      }
    }
  }
}

afterEach(() => {
  resetBrowserClientDownloadRouting()
})

describe('BrowserClientDownloadRelay', () => {
  it('streams the staged file to the remote and reports the remote destination', async () => {
    const writes: { offset: number; final: boolean; contentBase64: string }[] = []
    const transport = negotiatedTransport((_method, params) => {
      const chunk = params as { offset: number; final: boolean; contentBase64: string }
      writes.push({ offset: chunk.offset, final: chunk.final, contentBase64: chunk.contentBase64 })
      return chunk.final
        ? { accepted: true, workspaceRelativePath: '.orca/browser-downloads/report.pdf' }
        : { accepted: true }
    })
    const { filesystem, removed } = memoryFilesystem(Buffer.from('hello world'))
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport,
      resolvePage: () => page,
      filesystem
    })

    const route = remoteRoute(relay.route({ guestWebContentsId: 7 }))

    const destination = await route.complete('report.pdf')

    expect(destination).toEqual({
      workspaceRelativePath: '.orca/browser-downloads/report.pdf',
      hostLabel: 'build-box'
    })
    expect(writes.at(0)?.offset).toBe(0)
    expect(writes.at(-1)).toMatchObject({ final: true, contentBase64: '', offset: 11 })
    expect(removed).toContain(route.stagingPath)
  })

  it('keeps the local fallback when the host never offered the file channel', () => {
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport: boundTransport('unsupported'),
      resolvePage: () => page,
      filesystem: memoryFilesystem(Buffer.alloc(0)).filesystem
    })

    expect(relay.route({ guestWebContentsId: 7 })).toEqual({ kind: 'local-fallback' })
  })

  it('reports an owned page whose channel is momentarily gone as unavailable', () => {
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport: boundTransport('unavailable'),
      resolvePage: () => page,
      filesystem: memoryFilesystem(Buffer.alloc(0)).filesystem
    })

    expect(relay.route({ guestWebContentsId: 7 })).toEqual({ kind: 'unavailable' })
  })

  it('claims no ownership of a WebContents that is not one of its pages', () => {
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport: negotiatedTransport(() => ({ accepted: true })),
      resolvePage: () => undefined,
      filesystem: memoryFilesystem(Buffer.alloc(0)).filesystem
    })

    expect(relay.route({ guestWebContentsId: 7 })).toEqual({ kind: 'unowned' })
  })

  it('aborts the remote transfer and removes the staged copy when a chunk is rejected', async () => {
    const aborted: unknown[] = []
    const transport = negotiatedTransport((method, params) => {
      if (method.endsWith('abort')) {
        aborted.push(params)
        return { released: true }
      }
      return { accepted: false }
    })
    const { filesystem, removed } = memoryFilesystem(Buffer.from('abc'))
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport,
      resolvePage: () => page,
      filesystem
    })

    const route = remoteRoute(relay.route({ guestWebContentsId: 7 }))
    await expect(route.complete('report.pdf')).rejects.toThrow(
      'browser_client_download_chunk_rejected'
    )
    expect(aborted).toHaveLength(1)
    expect(removed.length).toBeGreaterThan(0)
  })
})

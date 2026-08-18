import { afterEach, describe, expect, it } from 'vitest'

import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import { BrowserClientDownloadRelay } from './browser-client-download-relay'
import {
  routeBrowserClientDownload,
  setBrowserClientDownloadRouter
} from './browser-client-download-routing'
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
    sendFileChannelRequest: async (method, params) =>
      ({ ok: true, result: handler(method, params), _meta: {} }) as never
  })
  return transport
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
  setBrowserClientDownloadRouter(null)
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

    const route = relay.route({ guestWebContentsId: 7 })
    expect(route).not.toBeNull()

    const destination = await route?.complete('report.pdf')

    expect(destination).toEqual({
      workspaceRelativePath: '.orca/browser-downloads/report.pdf',
      hostLabel: 'build-box'
    })
    expect(writes.at(0)?.offset).toBe(0)
    expect(writes.at(-1)).toMatchObject({ final: true, contentBase64: '', offset: 11 })
    expect(removed).toContain(route?.stagingPath)
  })

  it('does not route a download when the file channel was never negotiated', () => {
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport: new BrowserClientFileChannelTransport(),
      resolvePage: () => page,
      filesystem: memoryFilesystem(Buffer.alloc(0)).filesystem
    })

    expect(relay.route({ guestWebContentsId: 7 })).toBeNull()
  })

  it('does not route a download for a WebContents that is not a client-hosted page', () => {
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport: negotiatedTransport(() => ({ accepted: true })),
      resolvePage: () => undefined,
      filesystem: memoryFilesystem(Buffer.alloc(0)).filesystem
    })

    expect(relay.route({ guestWebContentsId: 7 })).toBeNull()
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

    const route = relay.route({ guestWebContentsId: 7 })
    await expect(route?.complete('report.pdf')).rejects.toThrow(
      'browser_client_download_chunk_rejected'
    )
    expect(aborted).toHaveLength(1)
    expect(removed.length).toBeGreaterThan(0)
  })

  it('falls back to the desktop Downloads folder when no client router is registered', () => {
    expect(routeBrowserClientDownload({ guestWebContentsId: 7 })).toBeNull()
  })

  it('routes through the registered client router once one is installed', () => {
    const relay = new BrowserClientDownloadRelay({
      stagingRoot: '/tmp/staging',
      hostLabel: 'build-box',
      transport: negotiatedTransport(() => ({ accepted: true })),
      resolvePage: () => page,
      filesystem: memoryFilesystem(Buffer.alloc(0)).filesystem
    })
    setBrowserClientDownloadRouter(relay)

    expect(routeBrowserClientDownload({ guestWebContentsId: 7 })?.browserPageId).toBe('page-1')
  })

  it('keeps the local fallback when the router throws', () => {
    setBrowserClientDownloadRouter({
      route: () => {
        throw new Error('router exploded')
      }
    })

    expect(routeBrowserClientDownload({ guestWebContentsId: 7 })).toBeNull()
  })
})

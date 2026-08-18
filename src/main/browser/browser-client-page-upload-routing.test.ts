import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import { BrowserClientUploadStaging } from './browser-client-upload-staging'
import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'

const partition = `persist:orca-browser-v1-${'a'.repeat(64)}`
let stagingRoot = ''

beforeEach(async () => {
  stagingRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-upload-routing-')))
})

afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true })
})

function command(
  overrides: Partial<BrowserClientHostCommandEvent> & { commandSequence: number; commandId: string }
): BrowserClientHostCommandEvent {
  return {
    type: 'command',
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'client-a',
    browserHostGeneration: 3,
    pageCommandProtocolVersion: 1,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    ...overrides
  } as BrowserClientHostCommandEvent
}

const createPage = command({
  commandSequence: 1,
  commandId: 'create-a',
  command: { type: 'createPage', browserProfileId: 'profile-a', executionHostKey: 'execution-a' }
} as never)

function uploadCommand(files: string[]): BrowserClientHostCommandEvent {
  return command({
    commandSequence: 2,
    commandId: 'upload-a',
    command: { type: 'automation', method: 'browser.upload', params: { element: '#f', files } }
  } as never)
}

function createHarness(options: { fileChannel?: BrowserClientFileChannelTransport } = {}) {
  const uploadStaging = new BrowserClientUploadStaging(stagingRoot)
  const automationCalls: { params: { files?: unknown } }[] = []
  const executeAutomation = vi.fn(async (input: { params: { files?: unknown } }) => {
    automationCalls.push(input)
    return { uploaded: true }
  })
  const executor = new BrowserClientPageCommandExecutor({
    orcaProfileId: 'orca-profile-a',
    authorityConnectionIdentity: 'authority-a',
    retainNetworkRoute: async () => ({
      key: 'execution-a',
      executionHostIdentity: 'execution-record-a',
      proxyEndpoint: { host: '127.0.0.1' as const, port: 43123 },
      release: async () => {}
    }),
    selectRenderer: () => ({
      rendererWebContentsId: 11,
      isCurrent: () => true,
      mountPage: async () => ({ webContentsId: 41 }),
      retirePage: async () => {}
    }),
    routeSessions: { preparePage: async () => ({ partition, release: () => {} }) },
    routeWebContents: {
      claimGuestLifecycle: (registration: BrowserRoutePageGuestIdentity) => ({
        registration: { ...registration },
        guestAuthority: Symbol('guest'),
        whenDestroyed: Promise.resolve(),
        isCurrent: () => true
      }),
      registerGuest: () => true,
      grantNavigation: () => true,
      revokeNavigation: () => true,
      navigateGuest: async () => true,
      beginGuestRetirement: () => Promise.resolve()
    },
    executeAutomation,
    retireAutomation: async () => {},
    fileChannel: options.fileChannel,
    uploadStaging
  } as never)
  return { executor, executeAutomation, automationCalls, uploadStaging }
}

function negotiatedTransport(contents: string): BrowserClientFileChannelTransport {
  const transport = new BrowserClientFileChannelTransport()
  transport.bind({
    fileChannelNegotiated: true,
    sendFileChannelRequest: async () =>
      ({
        ok: true,
        result: {
          contentBase64: Buffer.from(contents).toString('base64'),
          bytesRead: contents.length,
          totalBytes: contents.length,
          eof: true
        },
        _meta: {}
      }) as never
  })
  return transport
}

describe('client-placed browser.upload routing', () => {
  it('never forwards the remote paths verbatim to the local automation runtime', async () => {
    const transport = negotiatedTransport('remote-bytes')
    const { executor, automationCalls } = createHarness({ fileChannel: transport })
    await executor.handle(createPage, new AbortController().signal)

    const result = await executor.handle(
      uploadCommand(['docs/report.pdf']),
      new AbortController().signal
    )

    expect(result).toEqual({ status: 'completed', value: { uploaded: true } })
    const forwarded = automationCalls[0].params.files as string[]
    expect(forwarded).not.toContain('docs/report.pdf')
    expect(path.basename(forwarded[0])).toBe('report.pdf')
    expect(forwarded[0].startsWith(stagingRoot)).toBe(true)
  })

  it('fails the command instead of resolving remote paths on this desktop when unnegotiated', async () => {
    const { executor, executeAutomation } = createHarness()
    await executor.handle(createPage, new AbortController().signal)

    const result = await executor.handle(
      uploadCommand(['/Users/someone/.ssh/id_ed25519']),
      new AbortController().signal
    )

    expect(result).toEqual({
      status: 'failed',
      errorCode: 'browser_client_file_channel_unsupported'
    })
    expect(executeAutomation).not.toHaveBeenCalled()
  })

  it('removes every staged copy when the executor closes', async () => {
    const transport = negotiatedTransport('remote-bytes')
    const { executor } = createHarness({ fileChannel: transport })
    await executor.handle(createPage, new AbortController().signal)
    await executor.handle(uploadCommand(['docs/report.pdf']), new AbortController().signal)

    await executor.close()

    expect(await readdir(stagingRoot)).toHaveLength(0)
  })
})

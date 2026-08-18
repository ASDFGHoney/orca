import { describe, expect, it } from 'vitest'

import { BrowserClientHostAttachParams } from '../../shared/browser-client-host-protocol'
import { createBrowserClientHostAttachRequest } from './browser-client-host-attach-request'
import { sameBrowserClientHostLeaseAuthority } from './browser-client-host-command-authority'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'

const leaseOptions = {
  pairing: {} as never,
  authorityRuntimeId: 'runtime-1',
  browserHostClientId: 'host-1',
  hostCapabilities: ['webview'],
  pageCommandProtocolVersion: 1 as const,
  onPageCommand: () => ({ status: 'completed' }) as never
}

describe('browser file channel negotiation', () => {
  it('requests the file channel only alongside the command protocol', () => {
    expect(
      createBrowserClientHostAttachRequest({
        ...leaseOptions,
        fileChannelProtocolVersion: 1
      }).params.fileChannelProtocolVersion
    ).toBe(1)

    expect(
      createBrowserClientHostAttachRequest({
        ...leaseOptions,
        onPageCommand: undefined,
        fileChannelProtocolVersion: 1
      }).params.fileChannelProtocolVersion
    ).toBeUndefined()
  })

  it('rejects an attach that asks for the file channel without command negotiation', () => {
    expect(
      BrowserClientHostAttachParams.safeParse({
        authorityRuntimeId: 'runtime-1',
        browserHostClientId: 'host-1',
        hostCapabilities: ['webview'],
        fileChannelProtocolVersion: 1
      }).success
    ).toBe(false)
  })

  it('treats a reconnect that drops the file channel as a different authority', () => {
    const negotiated = {
      authorityRuntimeId: 'runtime-1',
      authorityEpoch: 'epoch-1',
      browserHostClientId: 'host-1',
      browserHostGeneration: 1,
      pageCommandProtocolVersion: 1 as const,
      fileChannelProtocolVersion: 1 as const
    }

    expect(sameBrowserClientHostLeaseAuthority(negotiated, negotiated)).toBe(true)
    expect(
      sameBrowserClientHostLeaseAuthority(negotiated, {
        ...negotiated,
        fileChannelProtocolVersion: undefined
      })
    ).toBe(false)
  })

  it('reports the channel unavailable until a negotiated lease binds it', async () => {
    const transport = new BrowserClientFileChannelTransport()
    expect(transport.available).toBe(false)
    await expect(transport.request('browser.clientHost.fileChannel.read', {})).rejects.toThrow(
      'browser_client_file_channel_unsupported'
    )

    const sender = {
      fileChannelNegotiated: false,
      sendFileChannelRequest: async () => ({ ok: true, result: {}, _meta: {} }) as never
    }
    transport.bind(sender)
    expect(transport.available).toBe(false)

    const negotiatedSender = {
      fileChannelNegotiated: true,
      sendFileChannelRequest: async () =>
        ({ ok: true, result: { released: true }, _meta: {} }) as never
    }
    transport.bind(negotiatedSender)
    expect(transport.available).toBe(true)
    expect(await transport.request('browser.clientHost.fileChannel.abort', {})).toEqual({
      released: true
    })

    transport.unbind(negotiatedSender)
    expect(transport.available).toBe(false)
  })
})

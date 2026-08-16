import { beforeAll, describe, expect, it } from 'vitest'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { BrowserTabCreateParams } from '../../../src/main/runtime/rpc/methods/browser-tab-create-schema'
import { materializeReleaseCheckout, resolveBaselineReleaseRef } from './release-checkout'

type Schema = { parse: (value: unknown) => Record<string, unknown> }

const legacyRequest = {
  url: 'https://example.test',
  worktree: 'id:worktree-a',
  profileId: 'profile-a',
  waitForRegistration: true,
  activate: true,
  targetGroupId: 'group-a'
}

let baselineRef: string
let baselineRevision: string
let baselineTabCreate: Schema
let baselineProtocol: Record<string, unknown>

beforeAll(async () => {
  baselineRef = resolveBaselineReleaseRef()
  const checkout = materializeReleaseCheckout(baselineRef)
  baselineRevision = checkout.commit
  const [schemas, protocol] = await Promise.all([
    import(/* @vite-ignore */ `${checkout.root}/src/main/runtime/rpc/methods/browser-schemas.ts`),
    import(/* @vite-ignore */ `${checkout.root}/src/shared/protocol-version.ts`)
  ])
  baselineTabCreate = schemas.TabCreate as Schema
  baselineProtocol = protocol
})

describe('cross-version browser placement', () => {
  it('loads a real stable release without client-host capabilities', () => {
    expect(baselineRef).toMatch(/^v\d/)
    expect(baselineRevision).toMatch(/^[0-9a-f]{40}$/)
    expect(baselineProtocol).not.toHaveProperty('BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY')
    expect(baselineProtocol).not.toHaveProperty('BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY')
    expect(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY).toBe('browser.clientHost.v1')
    expect(BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY).toBe('network.browserTunnel.v1')
  })

  it('lets an old server ignore additive client placement', () => {
    expect(
      baselineTabCreate.parse({
        ...legacyRequest,
        placement: { kind: 'client', browserHostClientId: 'desktop-a' }
      })
    ).toEqual(legacyRequest)
  })

  it('lets a new server preserve an old request as server placement', () => {
    const parsed = BrowserTabCreateParams.parse(legacyRequest)

    expect(parsed).toEqual(legacyRequest)
    expect(parsed).not.toHaveProperty('placement')
  })
})

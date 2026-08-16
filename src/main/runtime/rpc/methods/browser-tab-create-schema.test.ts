import { describe, expect, it } from 'vitest'
import { BrowserTabCreateParams } from './browser-tab-create-schema'

describe('browser.tabCreate placement schema', () => {
  it('keeps placement optional for older clients', () => {
    expect(BrowserTabCreateParams.parse({ worktree: 'id:worktree-a' })).not.toHaveProperty(
      'placement'
    )
  })

  it.each([
    { kind: 'server' as const },
    { kind: 'client' as const, browserHostClientId: 'browser-client-a' }
  ])('accepts additive explicit $kind placement', (placement) => {
    expect(BrowserTabCreateParams.parse({ placement })).toMatchObject({ placement })
  })

  it('rejects malformed client placement identity', () => {
    expect(() =>
      BrowserTabCreateParams.parse({ placement: { kind: 'client', browserHostClientId: '' } })
    ).toThrow()
  })
})

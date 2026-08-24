import { describe, expect, it } from 'vitest'
import {
  RestoredAgentAuthorityResolver,
  type RestoredAgentAuthorityBinding,
  type RestoredAgentAuthorityHook
} from './restored-agent-authority-resolver'

const hook: RestoredAgentAuthorityHook = {
  identity: 'hook-a',
  paneKey: 'tab-a:leaf-a',
  worktreeKey: 'repo-a\0/worktree-a',
  hostKey: 'ssh:host-a'
}

function binding(
  overrides: Partial<RestoredAgentAuthorityBinding> = {}
): RestoredAgentAuthorityBinding {
  return {
    ptyId: 'pty-a',
    incarnationId: 'incarnation-a',
    lifecycleGeneration: 1,
    source: 'current',
    paneKey: hook.paneKey,
    worktreeKey: hook.worktreeKey,
    hostKey: hook.hostKey,
    ...overrides
  }
}

describe('RestoredAgentAuthorityResolver', () => {
  it('rejects current process evidence from another execution host', () => {
    const resolver = new RestoredAgentAuthorityResolver()

    expect(
      resolver.resolve({
        hook,
        current: binding({ hostKey: 'local' }),
        persisted: null
      })
    ).toEqual({ binding: null, hasExactBinding: false })
  })

  it('keeps one hook fenced to its first process incarnation', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    expect(resolver.resolve({ hook, current: binding(), persisted: null }).binding).toEqual(
      binding()
    )

    expect(
      resolver.resolve({
        hook,
        current: binding({ incarnationId: 'incarnation-b' }),
        persisted: null
      })
    ).toEqual({ binding: null, hasExactBinding: false })
  })

  it('treats lifecycle generations as fallback identity when incarnation exists', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    resolver.resolve({ hook, current: binding(), persisted: null })

    expect(
      resolver.resolve({
        hook,
        current: binding({ lifecycleGeneration: 2 }),
        persisted: null
      }).binding
    ).toEqual(binding({ lifecycleGeneration: 2 }))
  })

  it('rejects disagreement between current and persisted bindings', () => {
    const resolver = new RestoredAgentAuthorityResolver()

    expect(
      resolver.resolve({
        hook,
        current: binding({ incarnationId: 'incarnation-b' }),
        persisted: binding({ source: 'persisted' })
      })
    ).toEqual({ binding: null, hasExactBinding: false })
  })

  it('forgets commitments after their restored hook disappears', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    resolver.resolve({ hook, current: binding(), persisted: null })
    resolver.retain(new Set())

    expect(
      resolver.resolve({
        hook,
        current: binding({ incarnationId: 'incarnation-b' }),
        persisted: null
      }).binding
    ).toEqual(binding({ incarnationId: 'incarnation-b' }))
  })
})

import { describe, expect, it } from 'vitest'
import type { AutomationWorkspaceProvenance } from './worktree/types'
import {
  automationWorkspaceStorageAuthority,
  automationWorkspaceStorageCatalogRef
} from './automation-workspace-provenance'

const provenance = (overrides: Partial<AutomationWorkspaceProvenance>) =>
  ({ kind: 'created-by-automation', ...overrides }) as AutomationWorkspaceProvenance

describe('automation workspace storage authority', () => {
  it('keeps Runtime + SSH distinct from Desktop + SSH', () => {
    expect(
      automationWorkspaceStorageAuthority(
        provenance({ hostId: 'ssh:builder', storageAuthority: 'runtime' }),
        'gpu'
      )
    ).toEqual({ kind: 'runtime', environmentId: 'gpu' })
    expect(
      automationWorkspaceStorageAuthority(
        provenance({ hostId: 'ssh:builder', storageAuthority: 'desktop' }),
        'gpu'
      )
    ).toEqual({ kind: 'desktop' })
  })

  it('uses workspace ownership for provenance written by older runtimes', () => {
    expect(
      automationWorkspaceStorageAuthority(provenance({ hostId: 'ssh:builder' }), 'gpu')
    ).toEqual({ kind: 'runtime', environmentId: 'gpu' })
  })

  it('keeps the SSH selector with its storage authority', () => {
    expect(
      automationWorkspaceStorageCatalogRef(
        provenance({ hostId: 'ssh:builder', storageAuthority: 'runtime' }),
        'gpu'
      )
    ).toEqual({
      authority: { kind: 'runtime', environmentId: 'gpu' },
      selector: { kind: 'ssh', targetId: 'builder' }
    })
  })
})

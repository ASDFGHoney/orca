import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { recoverUnavailableRuntimeBrowserClientPages } from './runtime-browser-client-page-recovery'

const oldPlacement = Object.freeze({
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 4,
  pageHostGeneration: 7
})
const newPlacement = Object.freeze({ ...oldPlacement, pageHostGeneration: 8 })

describe('runtime browser client page recovery', () => {
  it('closes an unavailable generation before creating and navigating the next generation', async () => {
    const { authority, commands, notifyWorkspace, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([inventory('outcomeUnknown')]),
      authority,
      pages,
      notifyWorkspace
    })

    expect(commands).toEqual([
      { type: 'closePage', pageHostGeneration: 7 },
      { type: 'navigate', pageHostGeneration: 8 }
    ])
    expect(authority.createClientPage).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'page-a',
        browserHostClientId: 'host-a',
        pairedDeviceId: 'device-a',
        browserProfileId: 'profile-a',
        executionHostKey: 'native:runtime-a:1'
      })
    )
    expect(pages.getPage('page-a')).toMatchObject({
      placement: newPlacement,
      url: 'https://client-latest.internal/',
      loading: false
    })
    expect(notifyWorkspace).toHaveBeenCalledOnce()
  })

  it('retains an exact active generation without commands or metadata churn', async () => {
    const { authority, commands, notifyWorkspace, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([inventory('active')]),
      authority,
      pages,
      notifyWorkspace
    })

    expect(commands).toEqual([])
    expect(authority.createClientPage).not.toHaveBeenCalled()
    expect(pages.getPage('page-a')?.placement).toEqual(oldPlacement)
    expect(notifyWorkspace).not.toHaveBeenCalled()
  })

  it('treats negotiated missing inventory as absence and still allocates a fresh generation', async () => {
    const { authority, commands, pages } = harness()

    await recoverUnavailableRuntimeBrowserClientPages({
      lease: lease([]),
      authority,
      pages,
      notifyWorkspace: vi.fn()
    })

    expect(commands).toEqual([{ type: 'navigate', pageHostGeneration: 8 }])
    expect(pages.getPage('page-a')?.placement).toEqual(newPlacement)
  })
})

function harness() {
  const pages = new RuntimeBrowserPageRegistry()
  pages.publishClientPage({
    browserPageId: 'page-a',
    workspaceId: 'workspace-a',
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement: oldPlacement,
    url: 'https://server-known.internal/',
    loading: true,
    active: true
  })
  let placement: RuntimeBrowserClientPlacement | undefined = oldPlacement
  const commands: { type: string; pageHostGeneration: number }[] = []
  const authority = {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    getPlacement: vi.fn(() => placement),
    beginPageRetirement: vi.fn((browserPageId: string, expected: RuntimeBrowserClientPlacement) => {
      if (expected !== placement) {
        throw new Error('browser_page_placement_stale')
      }
      return { browserPageId, placement: expected }
    }),
    completePageRetirement: vi.fn(() => {
      placement = undefined
      return true
    }),
    createClientPage: vi.fn(async () => {
      placement = newPlacement
      return newPlacement
    }),
    issueClientPageCommand: vi.fn(
      (input: { pageHostGeneration: number }, command: { type: string }) => {
        commands.push({ type: command.type, pageHostGeneration: input.pageHostGeneration })
        return { event: {}, result: Promise.resolve({ status: 'completed' as const }) }
      }
    )
  }
  return { authority, commands, notifyWorkspace: vi.fn(), pages }
}

function lease(pageInventory: ReturnType<typeof inventory>[]) {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'host-a',
    browserHostGeneration: 4,
    pairedDeviceId: 'device-a',
    pageCommandProtocolVersion: 1 as const,
    pageInventoryProtocolVersion: 1 as const,
    pageReconciliationProtocolVersion: 1 as const,
    pageInventory
  }
}

function inventory(state: 'active' | 'outcomeUnknown') {
  return {
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'host-a',
    browserHostGeneration: 4,
    browserPageId: 'page-a',
    pageHostGeneration: 7,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    state,
    currentUrl: 'https://client-latest.internal/'
  } as const
}

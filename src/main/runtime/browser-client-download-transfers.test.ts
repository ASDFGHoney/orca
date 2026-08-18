import { describe, expect, it, vi } from 'vitest'

import {
  BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY,
  BrowserClientDownloadTransferStore,
  type BrowserClientDownloadTransferDependencies
} from './browser-client-download-transfers'

function createStore(overrides: Partial<BrowserClientDownloadTransferDependencies> = {}) {
  const written: { relativePath: string; contentBase64: string; append: boolean }[] = []
  const removed: string[] = []
  const committed: { tempRelativePath: string; finalRelativePath: string }[] = []
  const existing = new Set<string>()
  const dependencies: BrowserClientDownloadTransferDependencies = {
    writeChunk: async ({ relativePath, contentBase64, append }) => {
      written.push({ relativePath, contentBase64, append })
    },
    commit: async ({ tempRelativePath, finalRelativePath }) => {
      committed.push({ tempRelativePath, finalRelativePath })
    },
    remove: async ({ relativePath }) => {
      removed.push(relativePath)
    },
    ensureDirectory: async () => {},
    exists: async ({ relativePath }) => existing.has(relativePath),
    ...overrides
  }
  return {
    store: new BrowserClientDownloadTransferStore(dependencies),
    written,
    removed,
    committed,
    existing
  }
}

const base = {
  transferId: 'transfer-1',
  browserPageId: 'page-1',
  pageHostGeneration: 2,
  workspaceId: 'workspace-1',
  filename: 'report.pdf',
  platform: 'linux' as NodeJS.Platform
}

describe('BrowserClientDownloadTransferStore', () => {
  it('appends sequential chunks and commits into the workspace downloads directory', async () => {
    const { store, written, committed } = createStore()

    expect(
      await store.accept({
        ...base,
        contentBase64: Buffer.from('one').toString('base64'),
        offset: 0,
        final: false
      })
    ).toBeNull()
    const commit = await store.accept({
      ...base,
      contentBase64: Buffer.from('two').toString('base64'),
      offset: 3,
      final: true
    })

    expect(written.map((chunk) => chunk.append)).toEqual([false, true])
    expect(commit).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report.pdf`
    })
    expect(committed).toHaveLength(1)
    expect(committed[0].tempRelativePath).toContain('.incoming-transfer-1')
    expect(store.activeTransferCount()).toBe(0)
  })

  it('picks a collision-free name on the remote', async () => {
    const { store, existing } = createStore()
    existing.add(`${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report.pdf`)

    const commit = await store.accept({ ...base, contentBase64: '', offset: 0, final: true })

    expect(commit).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/report (1).pdf`
    })
  })

  it('strips path separators from a remote-supplied filename', async () => {
    const { store } = createStore()

    const commit = await store.accept({
      ...base,
      filename: '../../etc/passwd',
      contentBase64: '',
      offset: 0,
      final: true
    })

    expect(commit).toEqual({
      workspaceRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/passwd`
    })
  })

  it('drops the partial file when a chunk arrives out of order', async () => {
    const { store, removed } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    await expect(
      store.accept({ ...base, contentBase64: 'AAA=', offset: 99, final: false })
    ).rejects.toThrow('browser_client_download_transfer_out_of_order')
    expect(removed).toHaveLength(1)
    expect(store.activeTransferCount()).toBe(0)
  })

  it('drops the partial file when the remote write fails', async () => {
    const removed: string[] = []
    const { store } = createStore({
      writeChunk: async () => {
        throw new Error('remote disk full')
      },
      remove: async ({ relativePath }) => {
        removed.push(relativePath)
      }
    })

    await expect(
      store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })
    ).rejects.toThrow('remote disk full')
    expect(removed).toHaveLength(1)
    expect(store.activeTransferCount()).toBe(0)
  })

  it('releases every transfer owned by a closed page', async () => {
    const { store, removed } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })
    await store.accept({
      ...base,
      transferId: 'transfer-2',
      contentBase64: 'AAA=',
      offset: 0,
      final: false
    })
    await store.accept({
      ...base,
      browserPageId: 'page-2',
      transferId: 'transfer-3',
      contentBase64: 'AAA=',
      offset: 0,
      final: false
    })

    await store.releasePage('page-1')

    expect(removed).toHaveLength(2)
    expect(store.activeTransferCount()).toBe(1)
  })

  it('rejects a transfer resumed under a replaced page generation', async () => {
    const { store } = createStore()
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    await expect(
      store.accept({
        ...base,
        pageHostGeneration: 9,
        contentBase64: 'AAA=',
        offset: 2,
        final: false
      })
    ).rejects.toThrow('browser_client_download_transfer_stale')
  })

  it('bounds concurrent transfers', async () => {
    const dependencies = {
      writeChunk: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      ensureDirectory: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(false)
    }
    const store = new BrowserClientDownloadTransferStore(dependencies, 1)
    await store.accept({ ...base, contentBase64: 'AAA=', offset: 0, final: false })

    await expect(
      store.accept({
        ...base,
        transferId: 'transfer-2',
        contentBase64: 'AAA=',
        offset: 0,
        final: false
      })
    ).rejects.toThrow('browser_client_download_transfer_capacity')
  })

  it('rejects malformed base64 instead of silently truncating the file', async () => {
    const { store } = createStore()

    await expect(
      store.accept({ ...base, contentBase64: 'AA*A', offset: 0, final: false })
    ).rejects.toThrow('browser_client_file_channel_chunk_invalid')
  })
})

import { BrowserClientDownloadTransferStore } from './browser-client-download-transfers'

type RuntimeFileChannelHost = {
  writeFileExplorerFileBase64Chunk(
    worktree: string,
    relativePath: string,
    contentBase64: string,
    append: boolean
  ): Promise<unknown>
  commitFileExplorerUpload(
    worktree: string,
    tempRelativePath: string,
    finalRelativePath: string
  ): Promise<unknown>
  deleteFileExplorerPath(
    worktree: string,
    relativePath: string,
    recursive?: boolean
  ): Promise<unknown>
  createFileExplorerDir(worktree: string, relativePath: string): Promise<unknown>
  statRuntimeFile(worktree: string, relativePath: string): Promise<unknown>
}

const stores = new WeakMap<object, BrowserClientDownloadTransferStore>()

export function getBrowserClientDownloadTransferStore(
  runtime: RuntimeFileChannelHost
): BrowserClientDownloadTransferStore {
  let store = stores.get(runtime)
  if (!store) {
    store = new BrowserClientDownloadTransferStore({
      writeChunk: async ({ workspaceId, relativePath, contentBase64, append }) => {
        await runtime.writeFileExplorerFileBase64Chunk(
          workspaceId,
          relativePath,
          contentBase64,
          append
        )
      },
      commit: async ({ workspaceId, tempRelativePath, finalRelativePath }) => {
        await runtime.commitFileExplorerUpload(workspaceId, tempRelativePath, finalRelativePath)
      },
      remove: async ({ workspaceId, relativePath }) => {
        await runtime.deleteFileExplorerPath(workspaceId, relativePath, false)
      },
      ensureDirectory: async ({ workspaceId, relativePath }) => {
        await runtime.createFileExplorerDir(workspaceId, relativePath)
      },
      exists: async ({ workspaceId, relativePath }) => {
        try {
          await runtime.statRuntimeFile(workspaceId, relativePath)
          return true
        } catch {
          return false
        }
      }
    })
    stores.set(runtime, store)
  }
  return store
}

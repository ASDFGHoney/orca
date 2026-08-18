import { BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR } from '../../shared/browser-client-file-channel-methods'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'
import type { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import type { BrowserClientUploadStaging } from './browser-client-upload-staging'
import {
  fetchBrowserClientUploadFiles,
  readBrowserClientUploadPaths
} from './browser-client-upload-transfer'

/**
 * Runs a client-placed `browser.upload` against remote workspace paths: the runtime reads the bytes,
 * main stages them under its own scoped directory, the guest uploads the staged copies, and the
 * staging directory is removed whether the upload succeeded or failed.
 */
export async function executeBrowserClientUploadCommand(options: {
  event: BrowserClientHostCommandEvent
  params: Record<string, unknown>
  fileChannel: BrowserClientFileChannelTransport | undefined
  staging: BrowserClientUploadStaging | undefined
  run(params: Record<string, unknown>): Promise<unknown>
}): Promise<unknown> {
  const { fileChannel, staging } = options
  if (!fileChannel?.available || !staging) {
    throw new BrowserClientPageCommandError(BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR)
  }
  const remotePaths = readBrowserClientUploadPaths(options.params)
  const files = await fetchBrowserClientUploadFiles({
    request: (method, params) => fileChannel.request(method, params),
    event: options.event,
    remotePaths
  })
  const staged = await staging.stage({
    browserPageId: options.event.browserPageId,
    pageHostGeneration: options.event.pageHostGeneration,
    files
  })
  try {
    return await options.run({ ...options.params, files: [...staged.localFilePaths] })
  } finally {
    await staging.release(staged.stagingId)
  }
}

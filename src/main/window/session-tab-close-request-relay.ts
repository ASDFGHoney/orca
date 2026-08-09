import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  SessionTabCloseRequest,
  SessionTabCloseResponse
} from '../../shared/session-tab-close'

const SESSION_TAB_CLOSE_TIMEOUT_MS = 20_000

export async function requestSessionTabCloseFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string,
  worktreeId: string
): Promise<void> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener('ui:sessionTabCloseResponse', onResponse)
      reject(new Error('session_tab_close_timeout'))
    }, SESSION_TAB_CLOSE_TIMEOUT_MS)
    const onResponse = (event: Electron.IpcMainEvent, response: SessionTabCloseResponse): void => {
      if (event.sender !== mainWindow.webContents || response.requestId !== requestId) {
        return
      }
      clearTimeout(timeout)
      ipcMain.removeListener('ui:sessionTabCloseResponse', onResponse)
      if (response.error) {
        reject(new Error(response.error))
      } else {
        resolve()
      }
    }
    ipcMain.on('ui:sessionTabCloseResponse', onResponse)
    const request: SessionTabCloseRequest = { requestId, tabId, worktreeId }
    mainWindow.webContents.send('ui:sessionTabCloseRequest', request)
  })
}

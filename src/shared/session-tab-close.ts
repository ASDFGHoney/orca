export type SessionTabCloseRequest = {
  requestId: string
  tabId: string
  worktreeId: string
}

export type SessionTabCloseResponse = {
  requestId: string
  error?: string
}

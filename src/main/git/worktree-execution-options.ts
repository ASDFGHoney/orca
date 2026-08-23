export type GitWorktreeExecOptions = {
  wslDistro?: string
  signal?: AbortSignal
  timeout?: number
}

export function gitWorktreeExecOptions(
  cwd: string,
  options: GitWorktreeExecOptions = {}
): { cwd: string; wslDistro?: string; signal?: AbortSignal; timeout?: number } {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {})
  }
}

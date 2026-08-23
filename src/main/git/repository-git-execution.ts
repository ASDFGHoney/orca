export type LocalGitExecOptions = {
  wslDistro?: string
}

export function repositoryGitExecOptions(
  cwd: string,
  options: LocalGitExecOptions = {}
): { cwd: string; wslDistro?: string } {
  return options.wslDistro ? { cwd, wslDistro: options.wslDistro } : { cwd }
}

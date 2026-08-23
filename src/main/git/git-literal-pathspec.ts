import type { GitRuntimeOptions } from './git-runtime-options'

export function literalGitPathspec(filePath: string, options: GitRuntimeOptions): string {
  // Why: Git inside WSL needs POSIX paths, but host paths must stay literal, so convert backslashes only for WSL.
  const runtimePath = options.wslDistro ? filePath.replace(/\\/g, '/') : filePath
  return `:(literal)${runtimePath}`
}

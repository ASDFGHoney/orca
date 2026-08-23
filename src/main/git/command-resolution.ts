import { getDefaultWslDistro, parseWslPath, type WslPathInfo } from '../wsl'
import { WSL_EXECUTABLE } from '../wsl/wsl-executable'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs,
  buildWslLoginShellCommand,
  quotePosixShell,
  type WslCapturedLoginShellCommand
} from '../../shared/wsl-login-shell-command'
import { UNTRANSLATED_GIT_OUTPUT_ENV } from '../../shared/git-output-locale'
import type { WslGitReadEnvironment } from './wsl-git-read-environment'
import { createAbortError } from './subprocess-lifecycle'

// ─── Core resolution ────────────────────────────────────────────────

// Env-assignment prefix for WSL-routed git, where spawn env can't cross the wsl.exe boundary; values are shell-safe unquoted.
const GIT_OUTPUT_LOCALE_SHELL_PREFIX = Object.entries(UNTRANSLATED_GIT_OUTPUT_ENV)
  .map(([key, value]) => `${key}=${value}`)
  .join(' ')
const GIT_OUTPUT_LOCALE_ENV_ARGS = Object.entries(UNTRANSLATED_GIT_OUTPUT_ENV).map(
  ([key, value]) => `${key}=${value}`
)

export type ResolvedCommand = {
  binary: string
  args: string[]
  cwd: string | undefined
  /** Non-null when the command was routed through WSL. */
  wsl: WslPathInfo | null
  wslMode: 'direct-git' | 'login-shell' | 'non-login-shell' | null
  /** Present only when the caller opted into a fenced login-shell read. */
  captured?: WslCapturedLoginShellCommand
}

/**
 * Translate Windows-style path arguments to Linux paths for commands run in WSL.
 *
 * Why: callers pass Windows paths as git arguments, which WSL git can't read.
 * UNC paths (\\wsl.localhost\…) become native Linux; drive paths (C:\…) → /mnt/c/…
 */
function translateArgsForWsl(args: string[]): string[] {
  return args.map(translateArgForWsl)
}

function translateArgForWsl(arg: string): string {
  // WSL UNC path → native linux path
  const wslInfo = parseWslPath(arg)
  if (wslInfo) {
    return wslInfo.linuxPath
  }

  // Windows drive path (e.g. C:\Users\...) → /mnt/c/Users/...
  const driveMatch = arg.match(/^([A-Za-z]):[/\\](.*)$/)
  if (driveMatch) {
    const driveLetter = driveMatch[1].toLowerCase()
    const rest = driveMatch[2].replace(/\\/g, '/')
    return `/mnt/${driveLetter}/${rest}`
  }

  return arg
}

function hasExplicitRepoArg(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (
      (args[i] === '--repo' || args[i] === '-R') &&
      typeof args[i + 1] === 'string' &&
      args[i + 1].trim()
    ) {
      return true
    }
    if (args[i].startsWith('--repo=') || args[i].startsWith('-R=')) {
      return args[i].slice(args[i].indexOf('=') + 1).trim().length > 0
    }
    if (args[i].startsWith('-R') && args[i].length > 2) {
      return args[i].slice(2).trim().length > 0
    }
  }
  return false
}

function argsUseGhApiPlaceholders(args: string[]): boolean {
  return args.some(
    (arg) => arg.includes('{owner}') || arg.includes('{repo}') || arg.includes('{branch}')
  )
}

function hasExplicitRepoViewTarget(args: string[]): boolean {
  const target = args[2]
  return (
    args[0] === 'repo' &&
    args[1] === 'view' &&
    typeof target === 'string' &&
    !target.startsWith('-') &&
    target.includes('/')
  )
}

function canRunGitHubCliWithoutRepoCwd(args: string[]): boolean {
  if (hasExplicitRepoArg(args)) {
    return true
  }
  if (args[0] === 'api') {
    return !argsUseGhApiPlaceholders(args)
  }
  return args[0] === 'auth' || hasExplicitRepoViewTarget(args)
}

function isMissingCommandInWsl(stderr: string, command: string): boolean {
  const s = stderr.toLowerCase()
  const c = command.toLowerCase()
  return s.includes(`${c}: command not found`) || s.includes(`${c}: not found`)
}

export function canFallBackToHostGitHubCli(
  command: 'gh',
  args: string[],
  resolved: ResolvedCommand,
  stderr: string
): boolean {
  return (
    process.platform === 'win32' &&
    resolved.wsl !== null &&
    isMissingCommandInWsl(stderr, command) &&
    canRunGitHubCliWithoutRepoCwd(args)
  )
}

export function resolveHostGitHubCli(command: 'gh', args: string[]): ResolvedCommand {
  return {
    binary: command,
    args,
    // Why: host gh can't use a WSL UNC cwd; we only fall back for commands with explicit repo/API context, so none is needed.
    cwd: undefined,
    wsl: null,
    wslMode: null
  }
}

let defaultWslDistroOverride: string | null = null
let waitForWindowsHostGitEnvironment: (() => Promise<void>) | null = null

// Why: allow host commands fallback to route through the user's pinned WSL distro when host execution fails.
export function setDefaultWslDistroOverride(distro: string | null): void {
  defaultWslDistroOverride = distro
}

export function configureWindowsHostGitEnvironmentReadiness(
  waitUntilReady: (() => Promise<void>) | null
): void {
  waitForWindowsHostGitEnvironment = waitUntilReady
}

function refreshWindowsHostPath(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) {
    return undefined
  }
  const currentPath = process.env.Path ?? process.env.PATH
  if (currentPath === undefined) {
    return env
  }
  const next = { ...env }
  const pathKeys = Object.keys(next).filter((key) => key.toLowerCase() === 'path')
  if (pathKeys.length === 0) {
    next[process.env.Path === undefined ? 'PATH' : 'Path'] = currentPath
  } else {
    for (const key of pathKeys) {
      next[key] = currentPath
    }
  }
  return next
}

export function prepareWindowsHostGitEnvironment(
  resolved: ResolvedCommand,
  env: NodeJS.ProcessEnv | undefined,
  signal?: AbortSignal
): Promise<NodeJS.ProcessEnv | undefined> | null {
  if (
    process.platform !== 'win32' ||
    resolved.wsl !== null ||
    waitForWindowsHostGitEnvironment === null
  ) {
    return null
  }
  const ready = waitForWindowsHostGitEnvironment().then(() => refreshWindowsHostPath(env))
  if (!signal) {
    return ready
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError())
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(createAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    ready.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(value)
      },
      (error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
    )
  })
}

export function resolveDefaultWslCli(
  command: 'gh' | 'glab',
  args: string[]
): ResolvedCommand | null {
  const distro = defaultWslDistroOverride ?? getDefaultWslDistro()
  return distro ? resolveCommand(command, args, undefined, distro) : null
}

export function isHostCommandMissing(err: unknown, command: 'gh' | 'glab'): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const e = err as { code?: unknown; message?: unknown; syscall?: unknown; path?: unknown }
  if (e.code === 'ENOENT') {
    return true
  }
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  return (
    message.includes('enoent') &&
    (message.includes(command) || e.path === command || e.syscall === 'spawn')
  )
}

/**
 * Resolve whether a command invocation should be routed through wsl.exe.
 *
 * Why `bash -c "cd … && …"` instead of `--cd`: wsl.exe's --cd fails with
 * ERROR_PATH_NOT_FOUND under Node's execFile/spawn in some configs.
 */
export function resolveCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  wslDistroOverride?: string,
  options: {
    useWslLoginShell?: boolean
    captureLoginShellOutput?: boolean
    wslGitReadEnvironment?: WslGitReadEnvironment
    env?: NodeJS.ProcessEnv
  } = {}
): ResolvedCommand {
  if (process.platform !== 'win32') {
    return { binary: command, args, cwd, wsl: null, wslMode: null }
  }

  // Why: global gh callers (rate_limit, listAccessibleProjects) have no cwd to derive a distro from; a distro hint still routes through wsl.exe.
  // TODO(wsl-default-distro): no default-distro setting yet, so override-less global gh callers fall back to host gh.exe (ENOENT on WSL-only installs).
  const cwdWsl = cwd ? parseWslPath(cwd) : null
  const wsl: WslPathInfo | null =
    cwdWsl ?? (wslDistroOverride ? { distro: wslDistroOverride, linuxPath: '' } : null)
  if (!wsl) {
    return { binary: command, args, cwd, wsl: null, wslMode: null }
  }

  const translatedArgs = translateArgsForWsl(args)
  // Why: env on wsl.exe stays Windows-side (WSLENV forwards only named vars), so the locale must ride the command string (issue #7808).
  const localePrefix = command === 'git' ? `${GIT_OUTPUT_LOCALE_SHELL_PREFIX} ` : ''
  const escapedCommand = quotePosixShell(command)
  // Why: shell-escape each arg to prevent word splitting / glob expansion inside the bash -c string.
  const escapedArgs = translatedArgs.map(quotePosixShell)
  // Why: prepend `cd <linuxPath> &&` for a UNC cwd; skip it when only a distro override was given (global gh needs no cwd).
  const linuxCwd = cwdWsl?.linuxPath ?? (cwd && wslDistroOverride ? translateArgForWsl(cwd) : null)
  const shellCmd = linuxCwd
    ? `cd ${quotePosixShell(linuxCwd)} && ${localePrefix}${escapedCommand} ${escapedArgs.join(' ')}`
    : `${localePrefix}${escapedCommand} ${escapedArgs.join(' ')}`

  if (command === 'git' && options.wslGitReadEnvironment) {
    const optionalLocks = options.env?.GIT_OPTIONAL_LOCKS
    return {
      binary: WSL_EXECUTABLE,
      args: [
        '-d',
        wsl.distro,
        '--exec',
        '/usr/bin/env',
        `PATH=${options.wslGitReadEnvironment.path}`,
        `HOME=${options.wslGitReadEnvironment.home}`,
        ...GIT_OUTPUT_LOCALE_ENV_ARGS,
        ...(optionalLocks !== undefined ? [`GIT_OPTIONAL_LOCKS=${optionalLocks}`] : []),
        options.wslGitReadEnvironment.gitPath,
        ...(linuxCwd ? ['-C', linuxCwd] : []),
        ...translatedArgs
      ],
      cwd: undefined,
      wsl,
      wslMode: 'direct-git'
    }
  }

  if (options.useWslLoginShell) {
    // Why opt-in: the login shell is interactive for bash/zsh, so its rc output
    // lands on stdout ahead of the payload. Callers that buffer the whole stream
    // fence it; streaming consumers (git grep, ls-files -z) must not, because a
    // marker would be glued onto their first record.
    if (options.captureLoginShellOutput) {
      const captured = buildWslCapturedLoginShellCommand(shellCmd)
      return {
        binary: WSL_EXECUTABLE,
        args: buildWslExecArgs(wsl.distro, ['sh', '-lc', captured.command]),
        cwd: undefined,
        wsl,
        wslMode: 'login-shell',
        captured
      }
    }
    return {
      binary: WSL_EXECUTABLE,
      args: buildWslExecArgs(wsl.distro, ['sh', '-lc', buildWslLoginShellCommand(shellCmd)]),
      cwd: undefined,
      wsl,
      wslMode: 'login-shell'
    }
  }

  return {
    binary: WSL_EXECUTABLE,
    args: buildWslExecArgs(wsl.distro, ['bash', '-c', shellCmd]),
    // Why: the `cd` inside bash -c handles the directory; a UNC cwd on the Node process is redundant and can break Node internals.
    cwd: undefined,
    wsl,
    wslMode: 'non-login-shell'
  }
}

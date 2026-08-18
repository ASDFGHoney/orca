import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  encodeShellStartupFeatures,
  selectShellStartupFeatures,
  SHELL_STARTUP_FEATURE_ENV,
  type ShellStartupFeature
} from '../main/shell-startup-features'
import { resolveInheritedZdotdir } from '../main/zsh-wrapper-dir-ownership'
import { ensureOverlayRestoreWrappers } from './pty-shell-overlay-wrappers'
const RELAY_SHELL_READY_DIR = '.orca-relay/shell-ready'
const POSIX_LOGIN_ARGS = ['-l']

export type RelayShellLaunchConfig = {
  args: string[]
  env: Record<string, string>
  supportsReadyMarker: boolean
}

function shellBasename(shellPath: string): string {
  return shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
}

/** The outer exe of a WSL launch; the shell the user actually types into lives
 *  inside the distro, so history/env handling must look past this name. */
export function isRelayWslShell(
  shellPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') {
    return false
  }
  const name = shellBasename(shellPath)
  return name === 'wsl.exe' || name === 'wsl'
}

function windowsShellArgs(
  shellName: string,
  options: { terminalWindowsWslDistro?: string | null } = {}
): string[] | null {
  if (shellName === 'powershell.exe' || shellName === 'powershell') {
    return ['-NoLogo']
  }
  if (shellName === 'pwsh.exe' || shellName === 'pwsh') {
    return ['-NoLogo']
  }
  if (shellName === 'cmd.exe' || shellName === 'cmd') {
    return []
  }
  if (shellName === 'wsl.exe' || shellName === 'wsl') {
    const distro = options.terminalWindowsWslDistro?.trim()
    return distro ? ['-d', distro] : []
  }
  return null
}

/**
 * Overlay values the relay's own wrapper re-applies. Only these (or a startup
 * command) may pull a remote zsh off the plain login fast path.
 *
 * Why the relay gates on its own list instead of `features.length`: its .zshenv
 * uses the overlay strategy, which resolves the user's config dir from a ZDOTDIR
 * Orca has already overwritten. A remote user whose zsh config lives in a
 * relocated ZDOTDIR therefore loses that config the moment the pane is wrapped,
 * so wrapping a pane just for `history` would trade a real config for a history
 * repair. Reconciling the overlay and discovery strategies is a follow-up.
 */
const RELAY_RESTORED_OVERLAY_ENV_KEYS = [
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_MIMOCODE_HOME',
  'ORCA_OMP_STATUS_EXTENSION',
  'ORCA_REMOTE_CLI_BIN_DIR'
] as const

function getWrapperRoot(env: Record<string, string>): string {
  return join(env.HOME || process.env.HOME || homedir(), RELAY_SHELL_READY_DIR)
}

export function getRelayShellLaunchConfig(
  shellPath: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  options: {
    emitReadyMarker?: boolean
    emitStartupIdentity?: boolean
    terminalWindowsWslDistro?: string | null
  } = {}
): RelayShellLaunchConfig {
  const shellName = shellBasename(shellPath)
  const unwrapped: RelayShellLaunchConfig = {
    args: POSIX_LOGIN_ARGS,
    env: {},
    supportsReadyMarker: false
  }
  if (platform === 'win32') {
    // Why: pwsh also exists on POSIX remotes; Windows-specific shell args must
    // only apply when the relay itself is running on native Windows.
    return {
      args:
        windowsShellArgs(shellName, {
          terminalWindowsWslDistro: options.terminalWindowsWslDistro
        }) ?? [],
      env: {},
      supportsReadyMarker: false
    }
  }

  if (shellName !== 'zsh' && shellName !== 'bash') {
    return unwrapped
  }

  // Why both map to the same flag: the relay only wraps for a startup command
  // when that command's delivery asked for the readiness handshake.
  const startupCommandRequested =
    options.emitReadyMarker === true || options.emitStartupIdentity === true
  const features = selectShellStartupFeatures({
    shellPath: shellName,
    env,
    hasStartupCommand: startupCommandRequested,
    waitsForShellReady: options.emitReadyMarker === true,
    emitsStartupIdentity: options.emitStartupIdentity === true
  })
  // Why bash is always wrapped: its rcfile carries the OSC 133 command-lifecycle
  // hooks unconditionally today, and dropping them would strand agent rows on
  // "working". zsh keeps the plain startup fast path when nothing needs it.
  const requiresZshWrapper =
    startupCommandRequested || RELAY_RESTORED_OVERLAY_ENV_KEYS.some((key) => Boolean(env[key]))
  if (shellName !== 'bash' && !requiresZshWrapper) {
    return unwrapped
  }

  const root = getWrapperRoot(env)
  let wrappersReady = false
  try {
    wrappersReady = ensureOverlayRestoreWrappers(root)
  } catch {
    // Why swallow: a remote HOME can be read-only or root-owned (EACCES), and
    // that must not stop the pane from opening at all.
    wrappersReady = false
  }
  if (!wrappersReady) {
    // Why plain login shell: ZDOTDIR pointed at an incomplete wrapper dir makes
    // zsh skip the user's whole config. Losing Orca's features is recoverable.
    return unwrapped
  }

  const featureEnv = {
    [SHELL_STARTUP_FEATURE_ENV]: encodeShellStartupFeatures(features)
  }
  const supportsReadyMarker = features.includes('ready')

  if (shellName === 'zsh') {
    return {
      args: POSIX_LOGIN_ARGS,
      env: {
        ORCA_ORIG_ZDOTDIR: resolveInheritedZdotdir(env, process.env.HOME ?? ''),
        ZDOTDIR: join(root, 'zsh'),
        ...featureEnv
      },
      supportsReadyMarker
    }
  }

  return {
    args: ['--rcfile', join(root, 'bash', 'rcfile')],
    env: featureEnv,
    supportsReadyMarker
  }
}

export type { ShellStartupFeature }

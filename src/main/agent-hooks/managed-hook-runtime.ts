import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import type { AgentHookTarget } from '../../shared/agent-hook-types'
import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem'
import { withManagedHookInstallLock } from './managed-hook-install-lock'
import {
  readManagedHookHostIdentity,
  scopeManagedHookHostIdentity
} from './managed-hook-owner-identity'

const execFileAsync = promisify(execFile)
const RELAY_ENV_HOME_MAX_LENGTH = 4096
const RELAY_ENV_HOME_PROBE_TIMEOUT_MS = 8_000

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
}

type RelayLoginEnvHome = 'GROK_HOME' | 'CODEX_HOME'

function defaultAgentHome(home: string, dirName: string): string {
  return `${home.replace(/\/+$/, '') || home}/${dirName}`
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function normalizePosixHome(candidate: string): string | null {
  if (
    candidate.length === 0 ||
    candidate.length > RELAY_ENV_HOME_MAX_LENGTH ||
    candidate !== candidate.trim() ||
    !candidate.startsWith('/') ||
    candidate.includes('\\') ||
    hasControlCharacter(candidate)
  ) {
    return null
  }
  return candidate.replace(/\/+$/, '') || '/'
}

function resolveLoginShell(): string {
  const candidate = process.env.SHELL || userInfo().shell || '/bin/sh'
  if (!candidate.startsWith('/') || candidate.includes('\\') || hasControlCharacter(candidate)) {
    return '/bin/sh'
  }
  return candidate
}

async function resolveRelayLoginEnvHome(
  home: string,
  envName: RelayLoginEnvHome,
  defaultDirName: string,
  signal?: AbortSignal
): Promise<string> {
  const fallback = defaultAgentHome(home, defaultDirName)
  try {
    const shell = resolveLoginShell()
    const shellName = basename(shell)
    const mode = shellName === 'sh' || shellName === 'dash' ? '-c' : '-lc'
    // Why: agent PTYs start login shells, so read the same profile-derived
    // home without opening two additional SSH exec channels.
    const { stdout } = await execFileAsync(
      shell,
      [mode, `printenv ${envName} | head -c ${RELAY_ENV_HOME_MAX_LENGTH + 1}`],
      { encoding: 'utf8', timeout: RELAY_ENV_HOME_PROBE_TIMEOUT_MS, signal }
    )
    return normalizePosixHome(stdout.split(/\r?\n/, 1)[0] ?? '') ?? fallback
  } catch {
    signal?.throwIfAborted()
    return fallback
  }
}

export async function resolveRelayGrokHome(home: string, signal?: AbortSignal): Promise<string> {
  return resolveRelayLoginEnvHome(home, 'GROK_HOME', '.grok', signal)
}

export async function resolveRelayCodexHome(home: string, signal?: AbortSignal): Promise<string> {
  return resolveRelayLoginEnvHome(home, 'CODEX_HOME', '.codex', signal)
}

export async function installManagedHooks(options?: {
  signal?: AbortSignal
  hostKeyFingerprint?: string
  agents?: readonly AgentHookTarget[]
}): Promise<ManagedHookInstallSummary> {
  options?.signal?.throwIfAborted()
  // Why: empty/omitted allowlist fails closed before any home/host probes.
  const agents = options?.agents ?? []
  if (agents.length === 0) {
    return { installers: 0, errors: 0 }
  }
  const home = homedir()
  const grokHomeDir = await resolveRelayGrokHome(home, options?.signal)
  const codexHomeDir = agents.includes('codex')
    ? await resolveRelayCodexHome(home, options?.signal)
    : undefined
  options?.signal?.throwIfAborted()
  const hostIdentity = scopeManagedHookHostIdentity(
    await readManagedHookHostIdentity(),
    options?.hostKeyFingerprint
  )
  return await withManagedHookInstallLock(
    home,
    options?.signal,
    async () => {
      const results = await installRemoteManagedAgentHooks(
        createManagedHookLocalFilesystem(),
        home,
        {
          grokHomeDir,
          ...(codexHomeDir ? { codexHomeDir } : {}),
          signal: options?.signal,
          agents
        }
      )
      return {
        installers: results.length,
        errors: results.filter((result) => result.state === 'error').length
      }
    },
    hostIdentity
  )
}

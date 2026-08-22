import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { createPendingProviderSnapshot } from './status-bar-provider-visibility'

/**
 * Which machine's usage the status-bar badges describe (#15798).
 *
 * With a remote Active Server the agents run there, so the badges must render
 * that server's numbers — the viewer's local poll describes a machine that runs
 * nothing and can look perfectly healthy while being wrong. Loss of contact is
 * its own verdict: per docs/reference/ssh-execution-boundary.md it may not be
 * collapsed into "still loading" or into a 0%/healthy bar.
 */
export type RemoteUsageState =
  | { kind: 'local' }
  /** A remote server owns usage and its first snapshot has not landed yet. */
  | { kind: 'remote-pending' }
  /** The server that owns usage cannot be reached, so its usage is unverifiable. */
  | { kind: 'remote-unreachable'; ownerLabel: string }
  | { kind: 'remote'; rateLimits: RateLimitState }

/**
 * Keys of RateLimitState that hold a provider snapshot. Derived rather than
 * listed so a newly added provider is a compile error in the maps below instead
 * of a silent leak of local numbers under a remote owner.
 */
type UsageProviderKey = {
  [K in keyof RateLimitState]-?: RateLimitState[K] extends ProviderRateLimits | null ? K : never
}[keyof RateLimitState]

const USAGE_PROVIDER_IDS: Record<UsageProviderKey, ProviderRateLimits['provider']> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencodeGo: 'opencode-go',
  kimi: 'kimi',
  antigravity: 'antigravity',
  minimax: 'minimax',
  grok: 'grok'
}

const USAGE_PROVIDER_KEYS = Object.keys(USAGE_PROVIDER_IDS) as UsageProviderKey[]

// Why: the host may predate a field the client now reads. RateLimitState types
// these as required, so read the remote copy through a Partial to keep the
// undefined branch reachable instead of letting a bar silently vanish.
type PartialRemoteRateLimitState = Partial<RateLimitState>

function replaceProviders(
  build: (providerId: ProviderRateLimits['provider']) => ProviderRateLimits
): Pick<RateLimitState, UsageProviderKey> {
  const replaced = {} as Pick<RateLimitState, UsageProviderKey>
  for (const key of USAGE_PROVIDER_KEYS) {
    replaced[key] = build(USAGE_PROVIDER_IDS[key])
  }
  return replaced
}

function createUnreachableProviderSnapshot(
  providerId: ProviderRateLimits['provider'],
  ownerLabel: string
): ProviderRateLimits {
  return {
    ...createPendingProviderSnapshot(providerId),
    error: translate(
      'auto.components.status.bar.usage.remoteOwnerUnreachable',
      'Usage unavailable — cannot reach {{server}}',
      { server: ownerLabel }
    ),
    status: 'error'
  }
}

function normalizeFlag(remoteValue: boolean | undefined, localValue: boolean): boolean {
  return typeof remoteValue === 'boolean' ? remoteValue : localValue
}

function adoptRemoteRateLimits(local: RateLimitState, remote: RateLimitState): RateLimitState {
  const partial = remote as PartialRemoteRateLimitState
  return {
    ...remote,
    // Why: MiniMax/Grok sign-in lives on disk, so a host older than those
    // providers omits the flags entirely; falling back to the local value keeps
    // a configured bar visible instead of making it disappear on the first
    // remote snapshot.
    minimaxCookieConfigured: normalizeFlag(
      partial.minimaxCookieConfigured,
      local.minimaxCookieConfigured
    ),
    grokAuthConfigured: normalizeFlag(partial.grokAuthConfigured, local.grokAuthConfigured),
    claudeTarget: partial.claudeTarget ?? local.claudeTarget,
    codexTarget: partial.codexTarget ?? local.codexTarget,
    inactiveClaudeAccounts: partial.inactiveClaudeAccounts ?? [],
    inactiveCodexAccounts: partial.inactiveCodexAccounts ?? []
  }
}

export function resolveStatusBarUsageRateLimits(
  localRateLimits: RateLimitState,
  remoteUsage: RemoteUsageState
): RateLimitState {
  if (remoteUsage.kind === 'local') {
    return localRateLimits
  }
  if (remoteUsage.kind === 'remote') {
    return adoptRemoteRateLimits(localRateLimits, remoteUsage.rateLimits)
  }
  // Why: never spread the local provider here. Keeping any local window would
  // render the viewer's percentages under the server's name — the exact
  // "looks correct, is wrong" failure #15798 reports.
  const providers =
    remoteUsage.kind === 'remote-unreachable'
      ? replaceProviders((providerId) =>
          createUnreachableProviderSnapshot(providerId, remoteUsage.ownerLabel)
        )
      : replaceProviders(createPendingProviderSnapshot)
  return { ...localRateLimits, ...providers }
}

/** Newest provider snapshot timestamp in a state, or 0 when nothing has landed. */
export function latestUsageUpdatedAt(rateLimits: RateLimitState | null): number {
  if (!rateLimits) {
    return 0
  }
  let newest = 0
  for (const key of USAGE_PROVIDER_KEYS) {
    const provider = rateLimits[key]
    if (provider && provider.updatedAt > newest) {
      newest = provider.updatedAt
    }
  }
  return newest
}

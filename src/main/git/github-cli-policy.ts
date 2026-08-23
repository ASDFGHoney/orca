import {
  createGhRateLimitBlockedError,
  getGhRateLimitBlockedUntilMs,
  ghRateLimitScopeKey,
  type GhRateLimitBucket
} from './gh-rate-limit-breaker'
import { parseRetryAfterMs } from './exec-error'
import type { ResolvedCommand } from './command-resolution'
import type { GitExecOptions } from './git-command-resolution'
import { createAbortError } from './subprocess-lifecycle'

// `cwd?` omitted for non-repo-scoped gh calls (rate_limit, listAccessibleProjects) so one WSL-aware wrapper serves both.
// `wslDistro?` routes global cwd-less gh through `wsl.exe -d <distro>` on WSL-only Windows where gh.exe isn't on host PATH.
// `idempotent?` gates transient-error retry (auto-detected from argv); retrying a write that already reached GitHub would duplicate it.
export type GhExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
  // Why: `gh api` and `--repo OWNER/REPO` shorthand resolve against gh's
  // default host, not the repo's remote. Carrying the host here lets the
  // runner qualify every spawn once, so call sites can't silently fall back
  // to github.com for GHES repos; it also scopes the rate-limit breaker.
  host?: string
}

const NON_IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
// `gh <noun> <verb>` write subcommands; reads are absent on purpose so they keep retrying.
const NON_IDEMPOTENT_GH_VERBS = new Set([
  'create',
  'edit',
  'update',
  'delete',
  'close',
  'reopen',
  'merge',
  'comment',
  'review',
  'ready',
  'lock',
  'unlock',
  'pin',
  'unpin',
  'transfer',
  'develop'
])

export function argsLookIdempotent(args: string[]): boolean {
  let explicitMethodSeen = false
  let hasApiBodyField = false
  let hasGraphQlQuery = false
  const isGraphQlApi = args[0] === 'api' && args[1] === 'graphql'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-X' || a === '--method') {
      explicitMethodSeen = true
      const next = args[i + 1]
      if (typeof next === 'string' && NON_IDEMPOTENT_METHODS.has(next.toUpperCase())) {
        return false
      }
    }
    // Single-token form `--method=POST` (gh accepts this).
    if (a.startsWith('--method=')) {
      explicitMethodSeen = true
      const value = a.slice('--method='.length)
      if (NON_IDEMPOTENT_METHODS.has(value.toUpperCase())) {
        return false
      }
    }
    // `gh api` auto-POSTs when -f/-F/--field body fields are given without -X; track them.
    if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      hasApiBodyField = true
    } else if (
      a.startsWith('-f=') ||
      a.startsWith('-F=') ||
      a.startsWith('--field=') ||
      a.startsWith('--raw-field=')
    ) {
      hasApiBodyField = true
    }
    // Detect GraphQL `query=mutation(…)` so endpoint writes also fail fast on transient errors.
    if (a.startsWith('query=')) {
      hasGraphQlQuery = true
      const trimmed = a.slice('query='.length).trimStart().toLowerCase()
      if (trimmed.startsWith('mutation')) {
        return false
      }
    }
  }
  // `gh api -f foo=bar` with no -X auto-POSTs → non-idempotent; GraphQL query bodies are the exception (still reads).
  if (
    args[0] === 'api' &&
    hasApiBodyField &&
    !explicitMethodSeen &&
    !(isGraphQlApi && hasGraphQlQuery)
  ) {
    return false
  }
  // `gh <noun> <verb>` writes (args[1]); `gh api` without -X defaults to idempotent GET, so it's excluded here.
  if (args.length >= 2 && args[0] !== 'api') {
    if (NON_IDEMPOTENT_GH_VERBS.has(args[1])) {
      return false
    }
  }
  return true
}

/**
 * Classify whether a gh execFile rejection is worth retrying.
 *
 * Why: gh surfaces HTTP status as stderr substrings ("HTTP 504", econnreset, …).
 * Retry 5xx/network resets and 429 only without Retry-After (propagate those so
 * the UI can show the wait); primary-rate-limit 403 is never transient.
 */
export function isTransientGhError(stderr: string): boolean {
  const s = stderr.toLowerCase()
  if (
    s.includes('http 500') ||
    s.includes('http 502') ||
    s.includes('http 503') ||
    s.includes('http 504') ||
    s.includes('econnreset') ||
    s.includes('etimedout') ||
    s.includes('socket hang up')
  ) {
    return true
  }
  // 429 without Retry-After: retry. With Retry-After: propagate.
  if (s.includes('http 429')) {
    return parseRetryAfterMs(stderr) === null
  }
  return false
}

// Why: 3 attempts total (250ms → 1s backoff); array length defines retry count (total attempts = length + 1).
export const GH_RETRY_DELAYS_MS = [250, 1000] as const

// Why: Retry-After is unbounded and untrusted; cap at 30s so a gh call can't block the IPC thread indefinitely.
export const GH_RETRY_AFTER_MAX_MS = 30_000
const DEFAULT_GH_EXEC_TIMEOUT_MS = 30_000

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError()
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => finish(createAbortError())
    function finish(error?: Error): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function defaultGhExecTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCA_GH_EXEC_TIMEOUT_MS
  if (!raw) {
    return DEFAULT_GH_EXEC_TIMEOUT_MS
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GH_EXEC_TIMEOUT_MS
}

export function nonInteractiveGhEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    GH_PROMPT_DISABLED: env.GH_PROMPT_DISABLED ?? '1'
  }
}

function hasGhHostnameFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--hostname' || arg.startsWith('--hostname='))
}

function hostQualifiedGhRepoValue(value: string, host: string): string {
  // URLs and already-qualified HOST/OWNER/REPO values pass through untouched.
  if (value.includes('://') || value.split('/').length !== 2) {
    return value
  }
  return `${host}/${value}`
}

/**
 * Host-qualify a gh invocation from `options.host`: `--hostname` for `api`
 * calls, `HOST/OWNER/REPO` for `--repo`/`-R` shorthand. SSH-backed repos run
 * gh with no cwd, so this is their only host signal (#8312).
 *
 * @internal exported for tests.
 */
export function applyGhHostToArgs(args: string[], host?: string): string[] {
  if (!host) {
    return args
  }
  let result = args
  if (result[0] === 'api' && !hasGhHostnameFlag(result)) {
    result = ['api', '--hostname', host, ...result.slice(1)]
  }
  // Why: bare OWNER/REPO shorthand resolves against gh's default host — GH_HOST
  // when set — so github.com must be qualified too, not just GHES, or a
  // process-level GH_HOST redirects pinned github.com commands.
  // Combined short forms (`-Ra/b`, `-R=a/b`) are deliberately not rewritten:
  // no call site uses them, and prefix-matching `-R` corrupts free-text values
  // of other flags (e.g. a --title that happens to start with `-R`).
  const qualified: string[] = []
  for (let i = 0; i < result.length; i += 1) {
    const arg = result[i]
    if (arg === '--repo' || arg === '-R') {
      qualified.push(arg)
      const value = result[i + 1]
      if (value !== undefined) {
        qualified.push(hostQualifiedGhRepoValue(value, host))
        i += 1
      }
      continue
    }
    if (arg.startsWith('--repo=')) {
      qualified.push(`--repo=${hostQualifiedGhRepoValue(arg.slice('--repo='.length), host)}`)
      continue
    }
    qualified.push(arg)
  }
  return qualified
}

function explicitGhHostname(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--hostname') {
      const value = args[i + 1]?.trim()
      return value || undefined
    }
    if (args[i].startsWith('--hostname=')) {
      const value = args[i].slice('--hostname='.length).trim()
      return value || undefined
    }
  }
  return undefined
}

function explicitGhRepoHostname(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    let value: string | undefined
    if (args[i] === '--repo' || args[i] === '-R') {
      value = args[i + 1]
    } else if (args[i].startsWith('--repo=')) {
      value = args[i].slice('--repo='.length)
    }
    const parts = value?.trim().split('/')
    if (parts?.length === 3 && parts.every(Boolean)) {
      return parts[0]
    }
  }
  return undefined
}

export function ghRateLimitScope(
  args: readonly string[],
  options: GhExecOptions,
  resolved: ResolvedCommand
): string {
  const runtime = resolved.wsl ? `wsl:${resolved.wsl.distro.toLowerCase()}` : 'native'
  // Why: an explicit argv hostname controls the actual gh request even when
  // GH_HOST or options.host disagree, so breaker state must follow that host.
  const host =
    explicitGhHostname(args) ??
    options.host ??
    explicitGhRepoHostname(args) ??
    options.env?.GH_HOST ??
    process.env.GH_HOST ??
    'github.com'
  return ghRateLimitScopeKey(runtime, host)
}

export function assertGhRateLimitScopeAvailable(
  args: readonly string[],
  options: GhExecOptions,
  resolved: ResolvedCommand,
  bucket: GhRateLimitBucket,
  exemptProbe: boolean
): void {
  if (exemptProbe) {
    return
  }
  const blockedUntilMs = getGhRateLimitBlockedUntilMs(
    bucket,
    Date.now(),
    ghRateLimitScope(args, options, resolved)
  )
  if (blockedUntilMs !== null) {
    throw createGhRateLimitBlockedError(bucket, blockedUntilMs)
  }
}

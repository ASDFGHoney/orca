import {
  classifyGhRateLimitBucket,
  isGhPrimaryRateLimitStderr,
  isGhRateLimitProbe,
  notifyGhPrimaryRateLimit
} from './gh-rate-limit-breaker'
import { extractExecError, parseRetryAfterMs } from './exec-error'
import {
  canFallBackToHostGitHubCli,
  isHostCommandMissing,
  resolveCommand,
  resolveDefaultWslCli,
  resolveHostGitHubCli
} from './command-resolution'
import { execFileCapture } from './exec-file-capture'
import {
  applyGhHostToArgs,
  argsLookIdempotent,
  assertGhRateLimitScopeAvailable,
  defaultGhExecTimeoutMs,
  ghRateLimitScope,
  GH_RETRY_AFTER_MAX_MS,
  GH_RETRY_DELAYS_MS,
  isTransientGhError,
  nonInteractiveGhEnv,
  sleep,
  type GhExecOptions
} from './github-cli-policy'

/**
 * Async gh CLI execution. Drop-in replacement for
 * `execFileAsync('gh', args, { cwd, encoding, ... })`.
 *
 * Retries transient 5xx / 429-without-Retry-After / network-reset failures with
 * exponential backoff; other errors fail fast.
 */
export async function ghExecFileAsync(
  args: string[],
  options: GhExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  // Why: retry safety must reflect the original call even when fallbacks replace the resolved command.
  const idempotent = options.idempotent ?? argsLookIdempotent(args)
  args = applyGhHostToArgs(args, options.host)
  let resolved = resolveCommand('gh', args, options.cwd, options.wslDistro)
  // Why: while a bucket is rate-limited every spawn returns 403 — fail fast; the probe is exempt so the breaker can learn the reset.
  // Why: scope by runtime and host so unrelated github.com, GHES, and WSL quotas cannot block each other.
  const rateLimitBucket = classifyGhRateLimitBucket(args)
  const rateLimitProbe = isGhRateLimitProbe(args)
  assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitProbe)
  let lastError: unknown
  let attemptedHostFallback = false
  let attemptedDefaultWslFallback = false
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const { stdout, stderr } = await execFileCapture(resolved.binary, resolved.args, {
        cwd: resolved.cwd,
        encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
        maxBuffer: options.maxBuffer,
        // Why: bound gh so one stuck child fails visibly instead of wedging the IPC lane.
        timeout: options.timeout ?? defaultGhExecTimeoutMs(options.env),
        env: nonInteractiveGhEnv(options.env),
        signal: options.signal
      })
      return { stdout: stdout as string, stderr: stderr as string }
    } catch (err) {
      lastError = err
      const { stderr } = extractExecError(err)
      if (isGhPrimaryRateLimitStderr(stderr)) {
        notifyGhPrimaryRateLimit(rateLimitBucket, ghRateLimitScope(args, options, resolved))
      }
      if (
        process.platform === 'win32' &&
        !attemptedDefaultWslFallback &&
        resolved.wsl === null &&
        !options.cwd &&
        !options.wslDistro &&
        isHostCommandMissing(err, 'gh')
      ) {
        const wslResolved = resolveDefaultWslCli('gh', args)
        if (wslResolved) {
          // Why: WSL-only Windows installs have no host gh.exe, and global calls (rate_limit/auth) carry no cwd to route by.
          resolved = wslResolved
          attemptedDefaultWslFallback = true
          assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitProbe)
          attempt = -1
          continue
        }
      }
      if (!attemptedHostFallback && canFallBackToHostGitHubCli('gh', args, resolved, stderr)) {
        resolved = resolveHostGitHubCli('gh', args)
        attemptedHostFallback = true
        assertGhRateLimitScopeAvailable(args, options, resolved, rateLimitBucket, rateLimitProbe)
        attempt = -1
        continue
      }
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      if (idempotent && !isLastAttempt && isTransientGhError(stderr)) {
        // Why: honor the server's Retry-After over our backoff (a shorter sleep just re-fails); cap so a huge hint can't stall IPC.
        const retryAfterMs = parseRetryAfterMs(stderr)
        const delayMs =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, GH_RETRY_AFTER_MAX_MS)
            : GH_RETRY_DELAYS_MS[attempt]
        await sleep(delayMs, options.signal)
        continue
      }
      throw err
    }
  }
  // Unreachable: the loop either returns or throws. Here for TS exhaustiveness.
  throw lastError
}

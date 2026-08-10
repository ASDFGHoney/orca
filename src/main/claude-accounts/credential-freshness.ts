/** Monotonic writes for credentials the caller has already matched to one account. */

export type CredentialWriteDecision = 'write' | 'keep-existing'

export function readCredentialExpiresAt(credentialsJson: string): number | null {
  const oauth = readOauthRecord(credentialsJson)
  if (!oauth) {
    return null
  }
  const value =
    readFiniteNumber(oauth.expiresAt) ??
    readFiniteNumber(oauth.expires_at) ??
    readFiniteNumber(oauth.expiry) ??
    readFiniteNumber(oauth.expires)
  if (value === null) {
    return null
  }
  // Why: older producers used epoch seconds while current Claude uses epoch milliseconds.
  return value > 0 && value < 100_000_000_000 ? value * 1000 : value
}

/**
 * Identity/account-switch decisions belong to the caller, which has account metadata.
 */
export function decideMonotonicCredentialWrite(input: {
  candidateJson: string
  existingJson: string | null
  equalExpiry?: 'write' | 'keep-existing'
}): CredentialWriteDecision {
  const { candidateJson, existingJson } = input
  if (existingJson === null || existingJson === '') {
    return 'write'
  }
  if (!hasAccessToken(existingJson)) {
    return 'write'
  }
  if (!hasAccessToken(candidateJson)) {
    return 'keep-existing'
  }
  const candidateExpiresAt = readCredentialExpiresAt(candidateJson)
  const existingExpiresAt = readCredentialExpiresAt(existingJson)

  if (existingExpiresAt === null && candidateExpiresAt === null) {
    return 'keep-existing'
  }
  if (candidateExpiresAt === null) {
    return 'keep-existing'
  }
  if (existingExpiresAt === null) {
    return 'write'
  }
  if (candidateExpiresAt < existingExpiresAt) {
    return 'keep-existing'
  }
  if (candidateExpiresAt === existingExpiresAt) {
    return input.equalExpiry ?? 'keep-existing'
  }
  return 'write'
}

export function pickFreshestCredentialsJson(
  candidates: (string | null | undefined)[]
): string | null {
  let freshest: string | null = null
  let freshestExpiresAt: number | null = null
  for (const candidate of candidates) {
    if (!candidate || !hasAccessToken(candidate)) {
      continue
    }
    const expiresAt = readCredentialExpiresAt(candidate)
    if (freshest === null) {
      freshest = candidate
      freshestExpiresAt = expiresAt
      continue
    }
    if (expiresAt !== null && (freshestExpiresAt === null || expiresAt > freshestExpiresAt)) {
      freshest = candidate
      freshestExpiresAt = expiresAt
    }
  }
  return freshest
}

function hasAccessToken(credentialsJson: string): boolean {
  const oauth = readOauthRecord(credentialsJson)
  if (!oauth) {
    return false
  }
  const accessToken = oauth.accessToken
  return typeof accessToken === 'string' && accessToken.trim() !== ''
}

function readOauthRecord(credentialsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(credentialsJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) {
      return null
    }
    return oauth as Record<string, unknown>
  } catch {
    return null
  }
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return null
}

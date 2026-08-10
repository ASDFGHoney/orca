/**
 * Monotonic credential writes for shared Claude auth stores.
 * Prefer later expiresAt; never regress a same-identity snapshot with an older one.
 */

export type CredentialWriteDecision = 'write' | 'keep-existing'

type CredentialIdentity = {
  accountUuid: string | null
  email: string | null
  organizationUuid: string | null
}

export function readCredentialExpiresAt(credentialsJson: string): number | null {
  const oauth = readOauthRecord(credentialsJson)
  if (!oauth) {
    return null
  }
  return (
    readFiniteNumber(oauth.expiresAt) ??
    readFiniteNumber(oauth.expires_at) ??
    readFiniteNumber(oauth.expiry) ??
    readFiniteNumber(oauth.expires)
  )
}

export function credentialsShareComparableIdentity(
  candidateJson: string,
  existingJson: string
): boolean {
  const candidate = readCredentialIdentity(candidateJson)
  const existing = readCredentialIdentity(existingJson)
  if (!candidate || !existing) {
    // Why: unknown identity cannot prove an intentional account switch; apply monotonic safety.
    return true
  }

  if (
    candidate.accountUuid &&
    existing.accountUuid &&
    candidate.accountUuid !== existing.accountUuid
  ) {
    return false
  }
  if (candidate.email && existing.email && candidate.email !== existing.email) {
    return false
  }
  if (
    candidate.organizationUuid &&
    existing.organizationUuid &&
    candidate.organizationUuid !== existing.organizationUuid &&
    !candidate.accountUuid &&
    !existing.accountUuid &&
    !candidate.email &&
    !existing.email
  ) {
    return false
  }

  if (
    candidate.accountUuid &&
    existing.accountUuid &&
    candidate.accountUuid === existing.accountUuid
  ) {
    return true
  }
  if (candidate.email && existing.email && candidate.email === existing.email) {
    return true
  }
  if (
    candidate.organizationUuid &&
    existing.organizationUuid &&
    candidate.organizationUuid === existing.organizationUuid
  ) {
    return true
  }

  // Why: insufficient shared identifiers — refuse same-identity regression rather than force a write.
  return true
}

/**
 * Decide whether `candidateJson` may replace `existingJson` on a shared auth surface.
 * Equal expiry is allowed (not a freshness regression). Missing candidate expiry keeps an
 * existing dated credential. Distinct identity always writes (account switch).
 */
export function decideMonotonicCredentialWrite(input: {
  candidateJson: string
  existingJson: string | null
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
  if (!credentialsShareComparableIdentity(candidateJson, existingJson)) {
    return 'write'
  }

  const candidateExpiresAt = readCredentialExpiresAt(candidateJson)
  const existingExpiresAt = readCredentialExpiresAt(existingJson)

  if (existingExpiresAt === null && candidateExpiresAt === null) {
    return 'write'
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

function readCredentialIdentity(credentialsJson: string): CredentialIdentity | null {
  const oauth = readOauthRecord(credentialsJson)
  if (!oauth) {
    return null
  }
  return {
    accountUuid: normalizeField(readString(oauth.accountUuid) ?? readString(oauth.accountId)),
    email: normalizeField(readString(oauth.email)),
    organizationUuid: normalizeField(
      readString(oauth.organizationUuid) ?? readString(oauth.organizationId)
    )
  }
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
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeField(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

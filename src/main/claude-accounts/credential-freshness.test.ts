import { describe, expect, it } from 'vitest'
import {
  credentialsShareComparableIdentity,
  decideMonotonicCredentialWrite,
  pickFreshestCredentialsJson,
  readCredentialExpiresAt
} from './credential-freshness'

function credentials(input: {
  email?: string
  accountUuid?: string
  organizationUuid?: string
  accessToken?: string
  expiresAt?: number | string | null
  omitExpiresAt?: boolean
}): string {
  const oauth: Record<string, unknown> = {
    accessToken: input.accessToken ?? 'token',
    refreshToken: `${input.accessToken ?? 'token'}-refresh`
  }
  if (input.email !== undefined) {
    oauth.email = input.email
  }
  if (input.accountUuid !== undefined) {
    oauth.accountUuid = input.accountUuid
  }
  if (input.organizationUuid !== undefined) {
    oauth.organizationUuid = input.organizationUuid
  }
  if (!input.omitExpiresAt) {
    oauth.expiresAt = input.expiresAt === undefined ? 2_000 : input.expiresAt
  }
  return JSON.stringify({ claudeAiOauth: oauth })
}

describe('credential-freshness', () => {
  it('reads expiresAt and expires_at aliases', () => {
    expect(readCredentialExpiresAt(credentials({ expiresAt: 5_000 }))).toBe(5_000)
    expect(
      readCredentialExpiresAt(
        JSON.stringify({ claudeAiOauth: { accessToken: 't', expires_at: 7_000 } })
      )
    ).toBe(7_000)
    expect(readCredentialExpiresAt('not-json')).toBeNull()
    expect(readCredentialExpiresAt(credentials({ expiresAt: 'bad' }))).toBeNull()
  })

  it('treats distinct emails as different identity so account switches can write', () => {
    expect(
      credentialsShareComparableIdentity(
        credentials({ email: 'a@example.com', expiresAt: 1_000 }),
        credentials({ email: 'b@example.com', expiresAt: 9_000 })
      )
    ).toBe(false)
  })

  it('keeps same-email credentials comparable for monotonic writes', () => {
    expect(
      credentialsShareComparableIdentity(
        credentials({ email: 'a@example.com', expiresAt: 1_000 }),
        credentials({ email: 'a@example.com', expiresAt: 9_000 })
      )
    ).toBe(true)
  })

  it('writes when there is no existing credential', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({ email: 'a@example.com', expiresAt: 1_000 }),
        existingJson: null
      })
    ).toBe('write')
  })

  it('keeps existing when candidate is strictly older for the same identity', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({
          email: 'a@example.com',
          accessToken: 'old',
          expiresAt: 1_000
        }),
        existingJson: credentials({ email: 'a@example.com', accessToken: 'new', expiresAt: 9_000 })
      })
    ).toBe('keep-existing')
  })

  it('writes when candidate is strictly newer for the same identity', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({
          email: 'a@example.com',
          accessToken: 'new',
          expiresAt: 9_000
        }),
        existingJson: credentials({ email: 'a@example.com', accessToken: 'old', expiresAt: 1_000 })
      })
    ).toBe('write')
  })

  it('writes when expiries are equal (not a freshness regression)', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({ email: 'a@example.com', accessToken: 'a', expiresAt: 5_000 }),
        existingJson: credentials({ email: 'a@example.com', accessToken: 'b', expiresAt: 5_000 })
      })
    ).toBe('write')
  })

  it('keeps existing dated credential when candidate expiresAt is missing or invalid', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({
          email: 'a@example.com',
          accessToken: 'missing',
          omitExpiresAt: true
        }),
        existingJson: credentials({
          email: 'a@example.com',
          accessToken: 'dated',
          expiresAt: 9_000
        })
      })
    ).toBe('keep-existing')
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({
          email: 'a@example.com',
          accessToken: 'bad',
          expiresAt: 'not-a-number'
        }),
        existingJson: credentials({
          email: 'a@example.com',
          accessToken: 'dated',
          expiresAt: 9_000
        })
      })
    ).toBe('keep-existing')
  })

  it('writes candidate when existing has no usable expiresAt', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({
          email: 'a@example.com',
          accessToken: 'dated',
          expiresAt: 9_000
        }),
        existingJson: credentials({
          email: 'a@example.com',
          accessToken: 'missing',
          omitExpiresAt: true
        })
      })
    ).toBe('write')
  })

  it('writes across different identities even when candidate expires earlier', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: credentials({ email: 'b@example.com', accessToken: 'b', expiresAt: 1_000 }),
        existingJson: credentials({ email: 'a@example.com', accessToken: 'a', expiresAt: 9_000 })
      })
    ).toBe('write')
  })

  it('keeps existing when candidate lacks an access token', () => {
    expect(
      decideMonotonicCredentialWrite({
        candidateJson: JSON.stringify({
          claudeAiOauth: { email: 'a@example.com', expiresAt: 9_000 }
        }),
        existingJson: credentials({ email: 'a@example.com', accessToken: 'ok', expiresAt: 1_000 })
      })
    ).toBe('keep-existing')
  })

  it('picks the freshest credential among diverged stores', () => {
    const stale = credentials({ email: 'a@example.com', accessToken: 'stale', expiresAt: 1_000 })
    const mid = credentials({ email: 'a@example.com', accessToken: 'mid', expiresAt: 2_000 })
    const fresh = credentials({ email: 'a@example.com', accessToken: 'fresh', expiresAt: 3_000 })
    expect(pickFreshestCredentialsJson([stale, null, fresh, mid, 'not-json'])).toBe(fresh)
    expect(pickFreshestCredentialsJson([null, undefined, ''])).toBeNull()
  })
})

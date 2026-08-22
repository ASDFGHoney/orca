/**
 * SecretStore abstracts at-rest secret encryption that the desktop gets from
 * Electron's `safeStorage` (OS keychain). A plain-Node host installs its own
 * implementation so core modules never import `electron`.
 *
 * The contract mirrors safeStorage exactly, including the part that matters most:
 * `isEncryptionAvailable()` may return false. A store that cannot seal must say so
 * rather than throw; how a caller degrades is its own decision (persistence retains
 * the prior sealed blob rather than writing plaintext). See `describeUnavailable()`,
 * which exists so the reason reaches the user, not a console warning nobody reads.
 */

export type SecretStore = {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(cipher: Buffer): string
  /**
   * Why: "encryption unavailable" is a security posture, not a detail. When
   * `isEncryptionAvailable()` is false this returns a short, user-safe sentence
   * explaining which host facility is missing, for the degradation surface.
   * Returns null when encryption IS available.
   */
  describeUnavailable(): string | null
}

let current: SecretStore | null = null

export function setSecretStore(store: SecretStore): void {
  current = store
}

export function getSecretStore(): SecretStore {
  if (!current) {
    throw new Error(
      'SecretStore not initialized — call setSecretStore() during startup before reading or writing secrets'
    )
  }
  return current
}

export function hasSecretStore(): boolean {
  return current !== null
}

/** Test-only: drop the installed store so suites do not leak one across files. */
export function _resetSecretStoreForTests(): void {
  current = null
}

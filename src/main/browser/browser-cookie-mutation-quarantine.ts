const mutationQuarantines = new WeakMap<object, Promise<void>>()

export const COOKIE_MUTATION_QUARANTINED_REASON =
  'A previous cookie import is still finishing in Chromium. Wait a moment and try again; if it continues, restart Orca.'

export class CookieMutationQuarantinedError extends Error {
  constructor() {
    super(COOKIE_MUTATION_QUARANTINED_REASON)
    this.name = 'CookieMutationQuarantinedError'
  }
}

export function quarantineCookieMutations(owner: object, until: Promise<void>): void {
  const quarantine = until.then(
    () => undefined,
    () => undefined
  )
  mutationQuarantines.set(owner, quarantine)
  void quarantine.then(() => {
    if (mutationQuarantines.get(owner) === quarantine) {
      mutationQuarantines.delete(owner)
    }
  })
}

export function assertCookieMutationsAvailable(owner: object): void {
  if (mutationQuarantines.has(owner)) {
    throw new CookieMutationQuarantinedError()
  }
}

export function isCookieMutationQuarantinedError(
  error: unknown
): error is CookieMutationQuarantinedError {
  return error instanceof CookieMutationQuarantinedError
}
